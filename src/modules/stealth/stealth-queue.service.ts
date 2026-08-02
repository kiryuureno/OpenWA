import { BadRequestException, Injectable, OnModuleDestroy, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { Session } from '../session/entities/session.entity';
import {
    interMessageGapMs,
    randomBetween,
    readingPauseMs,
    typingDurationMs,
} from './humanizer.util';
import { mergeStealthOverrides, resolveStealthConfig, StealthConfig } from './stealth-config';
import { StealthGuardService } from './stealth-guard.service';

/** What the send "looks like" to the recipient: text typing, media attach, or voice recording. */
export type StealthSendKind = 'text' | 'media' | 'voice';

export interface StealthSendRequest {
    chatId: string;
    kind: StealthSendKind;
    /** Length of the text/caption driving the typing-duration simulation (0 = media without caption). */
    textLength?: number;
    /** Fingerprint of the payload for the guard's repeated-content throttle (see content-fingerprint.ts). */
    contentKey?: string;
    /** Per-request opt-out: false executes immediately (direct engine call, no queue/humanization). */
    humanize?: boolean;
    /** Bulk/campaign traffic: queued behind conversational traffic on the same session. */
    background?: boolean;
    /** Caller-imposed minimum inter-message gap (bulk delayBetweenMessages floor). */
    minGapMs?: number;
}

interface StealthJob<T = unknown> {
    req: StealthSendRequest;
    run: (engine: IWhatsAppEngine) => Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
}

interface SessionQueue {
    jobs: StealthJob[];
    draining: boolean;
}

/** Per-session effective-config cache TTL (session overrides change rarely). */
const CONFIG_CACHE_TTL_MS = 15_000;
/** Minimum interval between two "online" presence flips on the same session. */
const PRESENCE_THROTTLE_MS = 30_000;

/**
 * Per-session humanizing send queue — the core of the stealth (anti-ban) layer.
 *
 * When stealth is enabled (default), every outbound send is serialized through a per-session FIFO
 * and wrapped in a pipeline that mimics a real phone user:
 *   circuit-breaker gate → reconnect grace → "online" presence → optional sendSeen →
 *   reading pause → typing/recording indicator (length-scaled) → the actual send →
 *   humanized inter-message gap (stretched by the guard's throttle multiplier).
 *
 * Why in-process and not BullMQ: the engine itself is the serialization point per session (see the
 * design note on MessageService), and the HTTP contract stays "request holds until the real send
 * completes" — a queued job resolves its caller's promise, so callers keep their current
 * request/response shape. Backpressure is a bounded pending-job count per session (503 past it).
 *
 * `humanize: false` (per request) bypasses the queue entirely and calls the engine directly,
 * preserving the legacy low-latency path for integrations that need it.
 */
@Injectable()
export class StealthQueueService implements OnModuleDestroy {
    private readonly logger = createLogger('StealthQueueService');
    private readonly queues = new Map<string, SessionQueue>();
    private readonly configCache = new Map<string, { config: StealthConfig; expiresAt: number }>();
    private readonly lastPresenceAt = new Map<string, number>();
    /** When the session was first observed READY (reconnect grace window start). */
    private readonly readyAt = new Map<string, number>();
    private readonly timers = new Set<NodeJS.Timeout>();
    private destroyed = false;

    constructor(
        private readonly engines: EngineRegistry,
        private readonly guard: StealthGuardService,
        @InjectRepository(Session, 'data')
        private readonly sessionRepository: Repository<Session>,
        @Optional()
        private readonly configService?: ConfigService,
    ) { }

    onModuleDestroy(): void {
        this.destroyed = true;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
    }

    /** Sleep tracked so module teardown can release held sends promptly on shutdown. */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.timers.delete(timer);
                resolve();
            }, ms);
            this.timers.add(timer);
        });
    }

    /**
     * Effective config for a session: env-level STEALTH_* merged with the session row's
     * `config.stealth` overrides. Cached briefly; the PATCH endpoint invalidates on write.
     */
    async getSessionConfig(sessionId: string): Promise<StealthConfig> {
        const cached = this.configCache.get(sessionId);
        if (cached && cached.expiresAt > Date.now()) return cached.config;
        const base = resolveStealthConfig(this.configService);
        let config = base;
        try {
            const row = await this.sessionRepository.findOne({ where: { id: sessionId }, select: { config: true } });
            config = mergeStealthOverrides(base, (row?.config as Record<string, unknown> | undefined)?.stealth);
        } catch (error) {
            this.logger.warn(`stealth: could not load session overrides for ${sessionId} (env config in use)`, {
                error: String(error),
            });
        }
        this.configCache.set(sessionId, { config, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
        return config;
    }

    /** Invalidate the cached effective config (called after a PATCH of the session's overrides). */
    invalidateSessionConfig(sessionId: string): void {
        this.configCache.delete(sessionId);
    }

    /** Record the moment a session was observed READY (drives the reconnect grace hold). */
    noteSessionReady(sessionId: string): void {
        this.readyAt.set(sessionId, Date.now());
    }

    /** Forget runtime state for a session (session stopped/deleted). */
    resetSession(sessionId: string): void {
        this.queues.delete(sessionId);
        this.configCache.delete(sessionId);
        this.lastPresenceAt.delete(sessionId);
        this.readyAt.delete(sessionId);
        this.guard.resetSession(sessionId);
    }

    /** Pending job count for the stats endpoint. */
    getQueueDepth(sessionId: string): number {
        return this.queues.get(sessionId)?.jobs.length ?? 0;
    }

    /**
     * Execute an outbound send, humanized. Resolves with the engine's result once the REAL send
     * completes (the caller's await keeps its current meaning). Throws whatever the engine threw so
     * the caller's failure path (persistence + message:failed hook) behaves exactly as before.
     */
    async executeSend<T>(
        sessionId: string,
        req: StealthSendRequest,
        run: (engine: IWhatsAppEngine) => Promise<T>,
    ): Promise<T> {
        const config = await this.getSessionConfig(sessionId);
        if (!config.enabled || req.humanize === false) {
            return this.executeDirect(sessionId, run);
        }
        const queue = this.queueFor(sessionId);
        if (queue.jobs.length >= config.queueMaxSize) {
            throw new ServiceUnavailableException(
                `Stealth queue for session '${sessionId}' is full (${config.queueMaxSize} pending); retry shortly`,
            );
        }
        return new Promise<T>((resolve, reject) => {
            const job: StealthJob<T> = { req, run, resolve, reject };
            // Conversational traffic goes ahead of background (bulk) traffic, FIFO within each class.
            if (req.background) {
                queue.jobs.push(job as StealthJob);
            } else {
                const firstBackground = queue.jobs.findIndex(j => j.req.background);
                if (firstBackground === -1) queue.jobs.push(job as StealthJob);
                else queue.jobs.splice(firstBackground, 0, job as StealthJob);
            }
            void this.drain(sessionId);
        });
    }

    /** Direct (non-humanized) path: the legacy behavior — immediate concurrent engine call. */
    private async executeDirect<T>(sessionId: string, run: (engine: IWhatsAppEngine) => Promise<T>): Promise<T> {
        const engine = this.engines.get(sessionId);
        if (!engine) {
            throw new BadRequestException(`Session '${sessionId}' is not active. Start the session first.`);
        }
        return run(engine);
    }

    private queueFor(sessionId: string): SessionQueue {
        let queue = this.queues.get(sessionId);
        if (!queue) {
            queue = { jobs: [], draining: false };
            this.queues.set(sessionId, queue);
        }
        return queue;
    }

    /** Serial drain of a session's queue; at most one runs per session at any time. */
    private async drain(sessionId: string): Promise<void> {
        const queue = this.queues.get(sessionId);
        if (!queue || queue.draining) return;
        queue.draining = true;
        try {
            while (queue.jobs.length > 0) {
                const job = queue.jobs.shift()!;
                const config = await this.getSessionConfig(sessionId);
                const sent = await this.processJob(sessionId, job, config);
                // Humanized gap BEFORE the next job (never after the last one — no dead time at the tail).
                if (sent && queue.jobs.length > 0 && !this.destroyed) {
                    const gap = await this.computeGapMs(sessionId, queue.jobs[0].req, config);
                    if (gap > 0) await this.sleep(gap);
                }
            }
        } finally {
            queue.draining = false;
            // A job enqueued between the last shift and this finally must not strand the queue.
            if (queue.jobs.length > 0 && !this.destroyed) void this.drain(sessionId);
        }
    }

    /**
     * Run one job through the humanization pipeline. Resolves true when the send executed (so the
     * drain applies an inter-message gap), false when it never reached the engine.
     */
    private async processJob(sessionId: string, job: StealthJob, config: StealthConfig): Promise<boolean> {
        const { req, run } = job;
        const engine = this.engines.get(sessionId);
        if (!engine) {
            job.reject(new BadRequestException(`Session '${sessionId}' is not active. Start the session first.`));
            return false;
        }
        try {
            // 1. Circuit breaker: hold (bounded) instead of sending into a suspected restriction.
            const circuitMs = this.guard.getCircuitRemainingMs(sessionId);
            if (circuitMs > 0) {
                this.logger.warn(`stealth: holding send to ${req.chatId} for ${Math.round(circuitMs / 1000)}s (circuit breaker, session ${sessionId})`);
                await this.sleep(circuitMs);
            }

            // 2. Reconnect grace: a human takes a moment to open the app after it (re)connects.
            await this.applyReconnectGrace(sessionId, config);

            // 3. "Online" presence (throttled — presence spam is itself an automation signal).
            await this.markOnlineThrottled(sessionId, engine, config);

            // 4. Optional read receipt: a human reads the chat before replying.
            if (config.markSeen) {
                await engine.sendSeen(req.chatId).catch(() => undefined);
            }

            // 5. Reading pause, then the typing/recording indicator for a length-scaled duration.
            await this.sleep(readingPauseMs(config.readingMinMs, config.readingMaxMs));
            if (config.typing) {
                const state = req.kind === 'voice' ? 'recording' : 'typing';
                await engine.sendChatState(req.chatId, state).catch(() => undefined);
                await this.sleep(
                    typingDurationMs(req.textLength ?? 0, {
                        minMs: config.typingMinMs,
                        maxMs: config.typingMaxMs,
                        charsPerSecond: config.charsPerSecond,
                    }),
                );
            }

            // 6. The real send.
            const result = await run(engine);

            // 7. Book-keeping: counters + throttle state (uses the delay context captured for the gap).
            const ctx = await this.guard.getDelayContext(sessionId, req.chatId, config, req.contentKey);
            await this.guard.noteSent(sessionId, req.chatId, ctx.isNewChat, req.contentKey);
            job.resolve(result);
            return true;
        } catch (error) {
            this.guard.noteFailure(sessionId, config);
            job.reject(error);
            return true; // it DID reach the engine — the next send still respects the pacing gap
        }
    }

    /** Inter-message gap for the NEXT job, stretched by the guard's throttle multiplier. */
    private async computeGapMs(sessionId: string, nextReq: StealthSendRequest, config: StealthConfig): Promise<number> {
        const ctx = await this.guard.getDelayContext(sessionId, nextReq.chatId, config, nextReq.contentKey);
        const isNew = ctx.isNewChat;
        const gap = interMessageGapMs({
            minMs: isNew ? config.newChatDelayMinMs : config.delayMinMs,
            maxMs: isNew ? config.newChatDelayMaxMs : config.delayMaxMs,
            distractionChance: config.distractionChance,
            distractionMinMs: config.distractionMinMs,
            distractionMaxMs: config.distractionMaxMs,
            multiplier: ctx.multiplier,
        });
        const floor = nextReq.minGapMs ?? 0;
        const effective = Math.max(gap, floor);
        if (ctx.multiplier > 1) {
            this.logger.log(
                `stealth: throttling session ${sessionId} (x${ctx.multiplier}: ${ctx.reasons.join(', ')}); next gap ${Math.round(effective / 1000)}s`,
            );
        }
        return effective;
    }

    /** Hold sends for a randomized grace window right after the session (re)connected. */
    private async applyReconnectGrace(sessionId: string, config: StealthConfig): Promise<void> {
        const readyAt = this.readyAt.get(sessionId);
        if (!readyAt) return;
        const graceMs = randomBetween(config.reconnectGraceMinMs, config.reconnectGraceMaxMs);
        const remaining = readyAt + graceMs - Date.now();
        if (remaining > 0) {
            this.logger.debug(`stealth: reconnect grace for session ${sessionId}; holding ${Math.round(remaining / 1000)}s`);
            await this.sleep(remaining);
        }
    }

    /** Flip the account "online" at most once per PRESENCE_THROTTLE_MS per session. */
    private async markOnlineThrottled(sessionId: string, engine: IWhatsAppEngine, config: StealthConfig): Promise<void> {
        if (!config.presenceEnabled || !engine.sendPresenceAvailable) return;
        const last = this.lastPresenceAt.get(sessionId) ?? 0;
        if (Date.now() - last < PRESENCE_THROTTLE_MS) return;
        this.lastPresenceAt.set(sessionId, Date.now());
        await engine.sendPresenceAvailable().catch(() => undefined);
    }
}
