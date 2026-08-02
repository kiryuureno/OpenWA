import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { EngineStatus } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { isQuietHoursActive, randomBetween } from './humanizer.util';
import { StealthGuardService } from './stealth-guard.service';
import { StealthQueueService } from './stealth-queue.service';

/** How often the service scans the live sessions. */
const PRESENCE_TICK_MS = 15_000;
/** Only flip "online" when the session sent something within this window — an account that goes
 *  online at random hours with zero activity is itself an automation signal. */
const ACTIVITY_WINDOW_MS = 5 * 60_000;

/**
 * Keeps a plausible "online" footprint for live sessions and tracks READY transitions for the
 * queue's reconnect grace.
 *
 * Two jobs on one slow tick:
 *  1. READY tracking — the first time a session is observed READY its timestamp is handed to the
 *     queue (noteSessionReady), which holds outbound sends for a randomized grace window: a human
 *     takes a moment to open the app after it connects, and an API that fires messages the same
 *     second the session links is a tell.
 *  2. Presence flips — around REAL activity only (the session sent within the last few minutes),
 *     at a randomized per-session interval, and never during configured quiet hours. Sending
 *     `available` presence at 3am on an idle account would look more bot-like than no presence.
 *
 * Poll-based by design: it needs no wiring into the session lifecycle (SessionService stays
 * untouched), at the cost of learning about a READY transition up to one tick late — which only
 * ever makes the grace window start later, never earlier.
 */
@Injectable()
export class StealthPresenceService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = createLogger('StealthPresenceService');
    private timer?: NodeJS.Timeout;
    private readonly seenReady = new Set<string>();
    private readonly nextPresenceAt = new Map<string, number>();

    constructor(
        private readonly engines: EngineRegistry,
        private readonly queue: StealthQueueService,
        private readonly guard: StealthGuardService,
    ) { }

    onModuleInit(): void {
        this.timer = setInterval(() => void this.tick(), PRESENCE_TICK_MS);
        // Never keep the process alive for presence alone.
        this.timer.unref?.();
    }

    onModuleDestroy(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    private async tick(): Promise<void> {
        const live = new Set<string>();
        for (const [sessionId, engine] of this.engines.entries()) {
            live.add(sessionId);
            let ready = false;
            try {
                ready = engine.getStatus() === EngineStatus.READY;
            } catch {
                continue; // an engine mid-teardown can throw on getStatus; skip this tick
            }
            if (!ready) {
                this.seenReady.delete(sessionId);
                this.nextPresenceAt.delete(sessionId);
                continue;
            }

            if (!this.seenReady.has(sessionId)) {
                this.seenReady.add(sessionId);
                this.queue.noteSessionReady(sessionId);
            }

            try {
                const config = await this.queue.getSessionConfig(sessionId);
                if (!config.enabled || !config.presenceEnabled) continue;
                if (isQuietHoursActive(config.quietHours)) continue;
                if (!engine.sendPresenceAvailable) continue;

                const now = Date.now();
                if ((this.nextPresenceAt.get(sessionId) ?? 0) > now) continue;
                // Schedule the next flip first so a slow presence call can't re-enter.
                this.nextPresenceAt.set(
                    sessionId,
                    now + randomBetween(config.presenceMinIntervalMs, config.presenceMaxIntervalMs),
                );
                // Activity-gated: only look online when the account is actually doing something.
                if (now - this.guard.getLastSentAt(sessionId) > ACTIVITY_WINDOW_MS) continue;
                await engine.sendPresenceAvailable().catch(() => undefined);
            } catch (error) {
                this.logger.debug(`stealth: presence tick skipped for session ${sessionId}`, { error: String(error) });
            }
        }
        // Forget sessions that no longer have a live engine so the maps can't grow unboundedly.
        for (const sessionId of this.seenReady) {
            if (!live.has(sessionId)) this.seenReady.delete(sessionId);
        }
        for (const sessionId of this.nextPresenceAt.keys()) {
            if (!live.has(sessionId)) this.nextPresenceAt.delete(sessionId);
        }
    }
}
