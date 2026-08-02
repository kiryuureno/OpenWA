import { ConfigService } from '@nestjs/config';

/**
 * Stealth (anti-ban / humanization) configuration, resolved in three layers:
 *   built-in defaults  <-  STEALTH_* environment variables  <-  per-session overrides
 * Per-session overrides live in the Session row's `config` JSON column under the `stealth` key and
 * only whitelisted keys (STEALTH_SESSION_OVERRIDE_KEYS) are honored — an operator can tune a
 * session's pacing without restarting the process.
 *
 * Env parsing mirrors the conventions of config/feature-flags.ts: `=== 'true'` for opt-in booleans,
 * `!== 'false'` for opt-out booleans, and numeric parses that fall back to the default on garbage
 * so a mis-typed value can never silently disable the safety layer.
 */
export interface StealthConfig {
    /** Master switch for the humanization pipeline. Default ON (STEALTH_MODE). */
    enabled: boolean;
    /** Typing/recording indicator before sends. Default ON; also disabled by legacy SIMULATE_TYPING=false. */
    typing: boolean;
    typingMinMs: number;
    typingMaxMs: number;
    charsPerSecond: number;
    /** Normal inter-message gap range on a session. */
    delayMinMs: number;
    delayMaxMs: number;
    /** Pre-send "reading" pause range (before the typing indicator appears). */
    readingMinMs: number;
    readingMaxMs: number;
    /** Probability of a longer "distraction" pause between two sends (0..1). */
    distractionChance: number;
    distractionMinMs: number;
    distractionMaxMs: number;
    /** Wider gap range used for the FIRST message to a previously unseen chat. */
    newChatDelayMinMs: number;
    newChatDelayMaxMs: number;
    /** Soft daily outbound cap per session (0 = unlimited). Crossing it only raises the throttle. */
    dailyCap: number;
    /** Soft daily cap on first-contact chats per session (0 = unlimited). */
    newChatDailyCap: number;
    /** Warm-up ramp for young sessions (0 = disabled): new-chat budget doubles each day up to the cap. */
    warmupDays: number;
    warmupStartNewChats: number;
    /** Mark the chat as read before replying (sendSeen). Default OFF (changes visible read state). */
    markSeen: boolean;
    /** Quiet-hours window "HH:MM-HH:MM" (local); empty = disabled. While active, gaps multiply. */
    quietHours: string;
    quietDelayMultiplier: number;
    /** Periodic "online" presence flips around real activity. Default ON. */
    presenceEnabled: boolean;
    presenceMinIntervalMs: number;
    presenceMaxIntervalMs: number;
    /** Hold sends for a randomized grace window right after a session becomes READY. */
    reconnectGraceMinMs: number;
    reconnectGraceMaxMs: number;
    /** Consecutive delivery failures that trip the circuit breaker, and its cooldown. */
    circuitThreshold: number;
    circuitCooldownMs: number;
    /** Max pending stealth jobs per session; beyond it sends are refused with 503. */
    queueMaxSize: number;
    /** Hard ceiling for the throttle multiplier applied to inter-message gaps. */
    maxThrottleMultiplier: number;
}

const num = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const float = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
};

/** Build the effective env-level config. Pure + parameterised for testability. */
export function computeStealthConfig(env: NodeJS.ProcessEnv = process.env): StealthConfig {
    return {
        enabled: env.STEALTH_MODE !== 'false',
        // The legacy SIMULATE_TYPING flag is honored so existing operators keep their setting when the
        // typing simulation moves into the stealth pipeline.
        typing: env.STEALTH_TYPING !== 'false' && env.SIMULATE_TYPING !== 'false',
        typingMinMs: num(env.STEALTH_TYPING_MIN_MS, 1200),
        typingMaxMs: num(env.STEALTH_TYPING_MAX_MS, 9000),
        charsPerSecond: float(env.STEALTH_CHARS_PER_SECOND, 4.5) || 4.5,
        delayMinMs: num(env.STEALTH_DELAY_MIN_MS, 2000),
        delayMaxMs: num(env.STEALTH_DELAY_MAX_MS, 6000),
        readingMinMs: num(env.STEALTH_READING_MIN_MS, 400),
        readingMaxMs: num(env.STEALTH_READING_MAX_MS, 1800),
        distractionChance: Math.min(1, float(env.STEALTH_DISTRACTION_CHANCE, 0.06)),
        distractionMinMs: num(env.STEALTH_DISTRACTION_MIN_MS, 8000),
        distractionMaxMs: num(env.STEALTH_DISTRACTION_MAX_MS, 20000),
        newChatDelayMinMs: num(env.STEALTH_NEW_CHAT_DELAY_MIN_MS, 5000),
        newChatDelayMaxMs: num(env.STEALTH_NEW_CHAT_DELAY_MAX_MS, 12000),
        dailyCap: num(env.STEALTH_DAILY_CAP, 200),
        newChatDailyCap: num(env.STEALTH_NEW_CHAT_DAILY_CAP, 25),
        warmupDays: num(env.STEALTH_WARMUP_DAYS, 7),
        warmupStartNewChats: num(env.STEALTH_WARMUP_START_NEW_CHATS, 15),
        markSeen: env.STEALTH_MARK_SEEN === 'true',
        quietHours: typeof env.STEALTH_QUIET_HOURS === 'string' ? env.STEALTH_QUIET_HOURS.trim() : '',
        quietDelayMultiplier: Math.max(1, float(env.STEALTH_QUIET_DELAY_MULTIPLIER, 3) || 3),
        presenceEnabled: env.STEALTH_PRESENCE !== 'false',
        presenceMinIntervalMs: num(env.STEALTH_PRESENCE_MIN_INTERVAL_MS, 120000),
        presenceMaxIntervalMs: num(env.STEALTH_PRESENCE_MAX_INTERVAL_MS, 300000),
        reconnectGraceMinMs: num(env.STEALTH_RECONNECT_GRACE_MIN_MS, 30000),
        reconnectGraceMaxMs: num(env.STEALTH_RECONNECT_GRACE_MAX_MS, 90000),
        circuitThreshold: Math.max(1, num(env.STEALTH_CIRCUIT_THRESHOLD, 5) || 5),
        circuitCooldownMs: num(env.STEALTH_CIRCUIT_COOLDOWN_MS, 600000),
        queueMaxSize: num(env.STEALTH_QUEUE_MAX_SIZE, 100),
        maxThrottleMultiplier: Math.max(1, float(env.STEALTH_MAX_THROTTLE_MULTIPLIER, 16) || 16),
    };
}

/**
 * Keys a per-session override may set. Timing/cap knobs an operator would legitimately tune per
 * number are included; internals that protect the deployment itself (queue size, circuit breaker,
 * throttle ceiling) are env-only so a compromised session scope can't disarm them.
 */
export const STEALTH_SESSION_OVERRIDE_KEYS = [
    'enabled',
    'typing',
    'markSeen',
    'dailyCap',
    'newChatDailyCap',
    'warmupDays',
    'quietHours',
    'delayMinMs',
    'delayMaxMs',
    'newChatDelayMinMs',
    'newChatDelayMaxMs',
    'typingMinMs',
    'typingMaxMs',
    'presenceEnabled',
] as const satisfies ReadonlyArray<keyof StealthConfig>;

export type StealthSessionOverrides = Partial<Pick<StealthConfig, (typeof STEALTH_SESSION_OVERRIDE_KEYS)[number]>>;

/**
 * Merge a session's `config.stealth` JSON over the env-level config. Only whitelisted keys with the
 * correct primitive type are applied; numbers are clamped to sane bounds so a bad override can
 * never produce a negative delay or an absurd cap.
 */
export function mergeStealthOverrides(base: StealthConfig, overrides: unknown): StealthConfig {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return base;
    const merged = { ...base };
    const src = overrides as Record<string, unknown>;
    const booleans = new Set(['enabled', 'typing', 'markSeen', 'presenceEnabled']);
    const numbers = new Set([
        'dailyCap',
        'newChatDailyCap',
        'warmupDays',
        'delayMinMs',
        'delayMaxMs',
        'newChatDelayMinMs',
        'newChatDelayMaxMs',
        'typingMinMs',
        'typingMaxMs',
    ]);
    for (const key of STEALTH_SESSION_OVERRIDE_KEYS) {
        const value = src[key];
        if (value === undefined) continue;
        if (booleans.has(key) && typeof value === 'boolean') {
            (merged as Record<string, unknown>)[key] = value;
        } else if (numbers.has(key) && typeof value === 'number' && Number.isFinite(value)) {
            (merged as Record<string, unknown>)[key] = Math.min(Math.max(Math.trunc(value), 0), 86_400_000);
        } else if (key === 'quietHours' && typeof value === 'string') {
            merged.quietHours = value.slice(0, 32).trim();
        }
    }
    return merged;
}

/**
 * Resolve the env-level config, preferring the ConfigService snapshot registered by
 * configuration.ts and falling back to a live process.env read (unit tests that build services
 * without the global ConfigModule rely on the live read).
 */
export function resolveStealthConfig(configService?: Pick<ConfigService, 'get'>): StealthConfig {
    const fromConfig = configService?.get<StealthConfig>('stealth');
    return fromConfig ?? computeStealthConfig();
}
