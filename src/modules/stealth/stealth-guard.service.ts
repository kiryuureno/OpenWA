import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { isQuietHoursActive } from './humanizer.util';
import { StealthConfig } from './stealth-config';

/** Sliding window for the repeated-content fingerprint detector (10 minutes). */
const REPEATED_CONTENT_WINDOW_MS = 10 * 60_000;
/** Distinct chats the same payload may reach inside the window before it is throttled. */
const REPEATED_CONTENT_CHAT_THRESHOLD = 8;
/** Cap on the per-session known-chat set so a contact-heavy account can't grow it unboundedly. */
const KNOWN_CHATS_MAX = 10_000;
/** Cap on tracked content fingerprints per session (oldest-window entries are re-created lazily). */
const FINGERPRINTS_MAX = 1_000;

interface ContentWindow {
    chats: Set<string>;
    windowStart: number;
}

interface SessionStealthState {
    /** Local date (YYYY-MM-DD) the daily counters belong to; they reset on rollover. */
    day: string;
    sentToday: number;
    newChatsToday: number;
    /** True once sentToday was seeded from the messages table for the current day. */
    seededFromDb: boolean;
    /** Chats this session has talked to (known = not a risky first contact). */
    knownChats: Set<string>;
    /** Content fingerprint -> distinct chats reached inside the sliding window. */
    fingerprints: Map<string, ContentWindow>;
    consecutiveFailures: number;
    circuitBrokenUntil: number;
    lastSentAt: number;
    /** Session row createdAt (ms epoch), cached for the warm-up ramp; 0 = not loaded. */
    sessionCreatedAtMs: number;
}

export interface StealthDelayContext {
    isNewChat: boolean;
    /** Throttle multiplier for the inter-message gap (1 = no throttle). Never blocks, only slows. */
    multiplier: number;
    /** Human-readable reasons that raised the multiplier (for logs + the stats endpoint). */
    reasons: string[];
}

export interface StealthSessionStats {
    sentToday: number;
    newChatsToday: number;
    dailyCap: number;
    newChatBudgetToday: number;
    consecutiveFailures: number;
    circuitBrokenUntil: number;
    lastSentAt: number;
    knownChats: number;
}

const localDay = (d = new Date()): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const startOfToday = (): Date => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
};

/**
 * Anti-ban guardrails for outbound traffic. Everything here is a THROTTLE, never a hard block
 * (per operator decision): crossing a soft cap only raises the delay multiplier the queue applies
 * to subsequent sends. The single exception is the circuit breaker — a burst of consecutive
 * delivery failures pauses the session's queue for a bounded cooldown, because continuing to send
 * into a likely restriction is how a number gets permanently banned.
 *
 * State is in-memory per process, with the daily sent counter seeded from the messages table so a
 * restart does not reset the day's budget. All DB lookups are lazy, cached, and best-effort: a
 * transient DB fault degrades the guard to in-memory-only rather than failing a send.
 */
@Injectable()
export class StealthGuardService {
    private readonly logger = createLogger('StealthGuardService');
    private readonly states = new Map<string, SessionStealthState>();

    constructor(
        @InjectRepository(Message, 'data')
        private readonly messageRepository: Repository<Message>,
        @InjectRepository(Session, 'data')
        private readonly sessionRepository: Repository<Session>,
        @Optional()
        private readonly configService?: ConfigService,
    ) { }

    private stateFor(sessionId: string): SessionStealthState {
        let state = this.states.get(sessionId);
        const today = localDay();
        if (!state) {
            state = {
                day: today,
                sentToday: 0,
                newChatsToday: 0,
                seededFromDb: false,
                knownChats: new Set(),
                fingerprints: new Map(),
                consecutiveFailures: 0,
                circuitBrokenUntil: 0,
                lastSentAt: 0,
                sessionCreatedAtMs: 0,
            };
            this.states.set(sessionId, state);
        } else if (state.day !== today) {
            // Day rollover: reset the daily budgets; chat knowledge and fingerprints survive.
            state.day = today;
            state.sentToday = 0;
            state.newChatsToday = 0;
            state.seededFromDb = false;
        }
        return state;
    }

    /** Seed the daily sent counter from the messages table (once per day per session). */
    private async ensureSeeded(sessionId: string, state: SessionStealthState): Promise<void> {
        if (state.seededFromDb) return;
        state.seededFromDb = true; // one attempt per day; a DB fault degrades to in-memory counting
        try {
            state.sentToday = await this.messageRepository.count({
                where: {
                    sessionId,
                    direction: MessageDirection.OUTGOING,
                    createdAt: MoreThanOrEqual(startOfToday()),
                },
            });
        } catch (error) {
            this.logger.warn(`stealth: could not seed daily counter for session ${sessionId} (using in-memory)`, {
                error: String(error),
            });
        }
    }

    private async ensureSessionAge(sessionId: string, state: SessionStealthState): Promise<void> {
        if (state.sessionCreatedAtMs !== 0) return;
        try {
            const row = await this.sessionRepository.findOne({ where: { id: sessionId }, select: { createdAt: true } });
            state.sessionCreatedAtMs = row?.createdAt ? new Date(row.createdAt).getTime() : -1;
        } catch (error) {
            state.sessionCreatedAtMs = -1; // unknown age → treated as established (no warm-up ramp)
            this.logger.warn(`stealth: could not load session age for ${sessionId} (warm-up skipped)`, { error: String(error) });
        }
    }

    /**
     * New-chat budget for today: while the session is younger than `warmupDays`, the budget starts at
     * `warmupStartNewChats` and doubles each day until it reaches `newChatDailyCap`. An established
     * session (or unknown age) gets the plain cap. 0 on either knob means "unlimited".
     */
    newChatBudgetToday(config: StealthConfig, state: SessionStealthState): number {
        if (config.newChatDailyCap <= 0) return Number.POSITIVE_INFINITY;
        if (config.warmupDays <= 0 || state.sessionCreatedAtMs <= 0) return config.newChatDailyCap;
        const ageDays = Math.floor((Date.now() - state.sessionCreatedAtMs) / 86_400_000);
        if (ageDays >= config.warmupDays) return config.newChatDailyCap;
        const budget = config.warmupStartNewChats * Math.pow(2, ageDays);
        return Math.min(config.newChatDailyCap, Math.max(1, Math.floor(budget)));
    }

    /**
     * Whether `chatId` is a first-contact chat for this session: not seen by the in-memory set AND
     * no stored messages with it. The s.whatsapp.net dialect twin is checked too — an older send may
     * have stored the raw engine id for the same chat. Result is cached in the known-chats set.
     */
    async isNewChat(sessionId: string, chatId: string): Promise<boolean> {
        const state = this.stateFor(sessionId);
        if (state.knownChats.has(chatId)) return false;
        try {
            const twin = chatId.endsWith('@c.us') ? chatId.replace(/@c\.us$/, '@s.whatsapp.net') : null;
            const candidates = twin ? [chatId, twin] : [chatId];
            const found = await this.messageRepository
                .createQueryBuilder('m')
                .select('m.id')
                .where('m.sessionId = :sessionId', { sessionId })
                .andWhere('m.chatId IN (:...candidates)', { candidates })
                .limit(1)
                .getOne();
            if (found) {
                this.rememberKnownChat(state, chatId);
                return false;
            }
        } catch (error) {
            // Best-effort: a DB fault treats the chat as known (normal pacing) rather than failing sends.
            this.logger.warn(`stealth: new-chat lookup failed for session ${sessionId} (treating as known)`, {
                error: String(error),
            });
            return false;
        }
        return true;
    }

    private rememberKnownChat(state: SessionStealthState, chatId: string): void {
        if (state.knownChats.size >= KNOWN_CHATS_MAX) return; // bounded; misses just re-hit the DB
        state.knownChats.add(chatId);
    }

    /**
     * Compute the delay context for one outbound send: whether the recipient is a first-contact chat
     * and the throttle multiplier the queue should apply to the inter-message gap. All factors are
     * multiplicative and clamped to config.maxThrottleMultiplier — traffic gets slower, never denied.
     */
    async getDelayContext(sessionId: string, chatId: string, config: StealthConfig, contentKey?: string): Promise<StealthDelayContext> {
        const state = this.stateFor(sessionId);
        await this.ensureSeeded(sessionId, state);
        await this.ensureSessionAge(sessionId, state);
        const isNew = await this.isNewChat(sessionId, chatId);

        let multiplier = 1;
        const reasons: string[] = [];

        if (config.dailyCap > 0 && state.sentToday > config.dailyCap) {
            // Progressive over-cap: each extra 25% of the cap doubles the multiplier (2,4,8,16).
            const over = state.sentToday / config.dailyCap - 1;
            const steps = Math.min(4, 1 + Math.floor(over * 4));
            multiplier *= Math.pow(2, steps);
            reasons.push(`daily-cap (${state.sentToday}/${config.dailyCap})`);
        }

        if (isNew) {
            const budget = this.newChatBudgetToday(config, state);
            if (state.newChatsToday >= budget) {
                multiplier *= 4;
                reasons.push(`new-chat-budget (${state.newChatsToday}/${budget === Number.POSITIVE_INFINITY ? '∞' : budget})`);
            }
        }

        if (contentKey && this.isRepeatedContent(state, contentKey, chatId)) {
            multiplier *= 2;
            reasons.push('repeated-content');
        }

        if (isQuietHoursActive(config.quietHours)) {
            multiplier *= config.quietDelayMultiplier;
            reasons.push('quiet-hours');
        }

        multiplier = Math.min(multiplier, config.maxThrottleMultiplier);
        return { isNewChat: isNew, multiplier, reasons };
    }

    /**
     * True when this exact payload already reached >= threshold distinct chats inside the sliding
     * window. Checked BEFORE the send is recorded, so the message that crosses the threshold is the
     * first one throttled.
     */
    private isRepeatedContent(state: SessionStealthState, contentKey: string, chatId: string): boolean {
        const window = state.fingerprints.get(contentKey);
        if (!window) return false;
        if (Date.now() - window.windowStart > REPEATED_CONTENT_WINDOW_MS) return false;
        return !window.chats.has(chatId) && window.chats.size >= REPEATED_CONTENT_CHAT_THRESHOLD;
    }

    /** Record a successful send: daily counters, chat knowledge, content fingerprint, failure streak. */
    async noteSent(sessionId: string, chatId: string, wasNewChat: boolean, contentKey?: string): Promise<void> {
        const state = this.stateFor(sessionId);
        await this.ensureSeeded(sessionId, state);
        state.sentToday++;
        if (wasNewChat) state.newChatsToday++;
        this.rememberKnownChat(state, chatId);
        state.consecutiveFailures = 0;
        state.lastSentAt = Date.now();

        if (contentKey) {
            if (state.fingerprints.size >= FINGERPRINTS_MAX && !state.fingerprints.has(contentKey)) {
                state.fingerprints.clear(); // bounded memory; windows rebuild lazily
            }
            let window = state.fingerprints.get(contentKey);
            if (!window || Date.now() - window.windowStart > REPEATED_CONTENT_WINDOW_MS) {
                window = { chats: new Set(), windowStart: Date.now() };
                state.fingerprints.set(contentKey, window);
            }
            window.chats.add(chatId);
        }
    }

    /**
     * Record a delivery failure. A streak of config.circuitThreshold consecutive failures trips the
     * circuit breaker: the session's queue pauses for config.circuitCooldownMs. Sending INTO a
     * suspected restriction is the classic way a soft block becomes a permanent ban, so this is the
     * one place stealth pauses traffic instead of just slowing it.
     */
    noteFailure(sessionId: string, config: StealthConfig): void {
        const state = this.stateFor(sessionId);
        state.consecutiveFailures++;
        if (state.consecutiveFailures >= config.circuitThreshold && Date.now() >= state.circuitBrokenUntil) {
            state.circuitBrokenUntil = Date.now() + config.circuitCooldownMs;
            this.logger.warn(
                `stealth: circuit breaker TRIPPED for session ${sessionId} after ${state.consecutiveFailures} consecutive ` +
                `send failures; holding outbound sends for ${Math.round(config.circuitCooldownMs / 1000)}s ` +
                `(possible WhatsApp restriction — investigate the number)`,
            );
        }
    }

    /** Remaining circuit-breaker hold (ms); 0 when the circuit is closed. */
    getCircuitRemainingMs(sessionId: string): number {
        const state = this.states.get(sessionId);
        if (!state) return 0;
        return Math.max(0, state.circuitBrokenUntil - Date.now());
    }

    /** Timestamp (ms epoch) of the last successful send, 0 when none. Used by the presence service. */
    getLastSentAt(sessionId: string): number {
        return this.states.get(sessionId)?.lastSentAt ?? 0;
    }

    /** Stats snapshot for the stealth stats endpoint. */
    async getStats(sessionId: string, config: StealthConfig): Promise<StealthSessionStats> {
        const state = this.stateFor(sessionId);
        await this.ensureSeeded(sessionId, state);
        await this.ensureSessionAge(sessionId, state);
        const budget = this.newChatBudgetToday(config, state);
        return {
            sentToday: state.sentToday,
            newChatsToday: state.newChatsToday,
            dailyCap: config.dailyCap,
            newChatBudgetToday: budget === Number.POSITIVE_INFINITY ? -1 : budget,
            consecutiveFailures: state.consecutiveFailures,
            circuitBrokenUntil: state.circuitBrokenUntil,
            lastSentAt: state.lastSentAt,
            knownChats: state.knownChats.size,
        };
    }

    /** Drop all runtime state for a session (session deleted/stopped — avoids unbounded growth). */
    resetSession(sessionId: string): void {
        this.states.delete(sessionId);
    }
}
