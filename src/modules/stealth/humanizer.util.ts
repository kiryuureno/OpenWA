// Humanized timing math for the stealth (anti-ban) layer.
//
// Every human-like delay in the codebase is computed here so the whole stealth pipeline shares one
// vocabulary: a real phone user does not act on metronomic intervals, so delays are drawn from
// light-tailed distributions (mostly short, occasionally a longer "distraction") with per-call
// jitter. All functions are pure and DI-free so they are trivially unit-testable.

/** Clamp `value` into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

/** Uniform random in [min, max] (max <= min collapses to min). */
export function randomBetween(min: number, max: number): number {
    if (max <= min) return min;
    return min + Math.random() * (max - min);
}

/** Approximate gaussian in [0, 1] via Irwin–Hall (mean of 3 uniforms), centred on ~0.5. */
function gaussian01(): number {
    return (Math.random() + Math.random() + Math.random()) / 3;
}

/** Approximately gaussian-distributed value in [min, max], biased toward the middle. */
export function gaussianBetween(min: number, max: number): number {
    if (max <= min) return min;
    return min + gaussian01() * (max - min);
}

/** True with probability `p` (0..1). */
export function chance(p: number): boolean {
    return Math.random() < p;
}

export interface TypingDurationOptions {
    /** Lower bound of the typing pause (ms). Also the floor for a media "attaching" pause. */
    minMs: number;
    /** Hard cap on the typing pause (ms) — long texts still cap out. */
    maxMs: number;
    /** Assumed typing speed in characters/second (~4.5 ≈ a brisk phone typist). */
    charsPerSecond: number;
}

/**
 * How long a human would plausibly take to type `chars` characters: a base reaction component plus
 * a length-scaled component with ±20% gaussian jitter, clamped to [minMs, maxMs]. For `chars <= 0`
 * (media without a caption) returns a short "attaching a file" pause instead — a human attaching
 * media still takes a moment before the send lands.
 */
export function typingDurationMs(chars: number, opts: TypingDurationOptions): number {
    const minMs = Math.max(0, opts.minMs);
    const maxMs = Math.max(minMs, opts.maxMs);
    const cps = opts.charsPerSecond > 0 ? opts.charsPerSecond : 4.5;
    if (!Number.isFinite(chars) || chars <= 0) {
        return Math.round(gaussianBetween(minMs, Math.min(minMs * 1.6, maxMs)));
    }
    const planned = minMs + (chars / cps) * 1000;
    const jittered = planned * (0.8 + gaussian01() * 0.4);
    return Math.round(clamp(jittered, minMs, maxMs));
}

export interface InterMessageGapOptions {
    /** Normal gap range (ms) between two sends on the same session. */
    minMs: number;
    maxMs: number;
    /** Probability of a longer "distraction" pause instead of the normal gap (0..1). */
    distractionChance: number;
    distractionMinMs: number;
    distractionMaxMs: number;
    /** Throttle multiplier applied by the guard (1 = no throttle). */
    multiplier?: number;
    /** Absolute ceiling (ms) so a large multiplier can never hold a job for unreasonable times. */
    hardCapMs?: number;
}

/**
 * Gap to wait before the next send on a session. Mostly a gaussian draw inside [minMs, maxMs];
 * occasionally a longer "user got distracted" pause. The guard's throttle multiplier stretches the
 * result (capped by hardCapMs, default 3 minutes) so over-budget traffic gets slower, never stuck.
 */
export function interMessageGapMs(opts: InterMessageGapOptions): number {
    const multiplier = opts.multiplier && opts.multiplier > 1 ? opts.multiplier : 1;
    const hardCap = opts.hardCapMs && opts.hardCapMs > 0 ? opts.hardCapMs : 180_000;
    const base = chance(clamp(opts.distractionChance, 0, 1))
        ? randomBetween(opts.distractionMinMs, opts.distractionMaxMs)
        : gaussianBetween(opts.minMs, opts.maxMs);
    return Math.round(clamp(base * multiplier, opts.minMs, hardCap));
}

/**
 * Short pre-send "reading" pause: the moment a human spends looking at the chat before they start
 * typing. Kept deliberately tight so the added latency is barely noticeable.
 */
export function readingPauseMs(minMs = 400, maxMs = 1800): number {
    return Math.round(gaussianBetween(minMs, maxMs));
}

/**
 * Parse a quiet-hours window "HH:MM-HH:MM" (local server time). Overnight windows (e.g.
 * "22:00-08:00") are supported. Returns { startMin, endMin } in minutes-since-midnight, or null
 * when the spec is empty/invalid (quiet hours disabled).
 */
export function parseQuietHours(spec: string | undefined): { startMin: number; endMin: number } | null {
    if (!spec) return null;
    const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(spec.trim());
    if (!m) return null;
    const startMin = Number(m[1]) * 60 + Number(m[2]);
    const endMin = Number(m[3]) * 60 + Number(m[4]);
    if (startMin > 1439 || endMin > 1439) return null;
    if (startMin === endMin) return null; // a zero-length window means "disabled", not "always"
    return { startMin, endMin };
}

/** True when `date` (default now, local time) falls inside the quiet-hours window. */
export function isQuietHoursActive(spec: string | undefined, date: Date = new Date()): boolean {
    const window = parseQuietHours(spec);
    if (!window) return false;
    const cur = date.getHours() * 60 + date.getMinutes();
    if (window.startMin < window.endMin) {
        return cur >= window.startMin && cur < window.endMin;
    }
    // Overnight window (e.g. 22:00-08:00): active after start OR before end.
    return cur >= window.startMin || cur < window.endMin;
}
