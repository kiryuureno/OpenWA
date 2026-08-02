import {
    computeStealthConfig,
    mergeStealthOverrides,
    resolveStealthConfig,
    STEALTH_SESSION_OVERRIDE_KEYS,
} from './stealth-config';

describe('computeStealthConfig', () => {
    it('produces the safe defaults from an empty env', () => {
        const config = computeStealthConfig({});
        expect(config.enabled).toBe(true);
        expect(config.typing).toBe(true);
        expect(config.markSeen).toBe(false);
        expect(config.presenceEnabled).toBe(true);
        expect(config.dailyCap).toBe(200);
        expect(config.newChatDailyCap).toBe(25);
        expect(config.warmupDays).toBe(7);
        expect(config.quietHours).toBe('');
        expect(config.circuitThreshold).toBe(5);
        expect(config.queueMaxSize).toBe(100);
        expect(config.maxThrottleMultiplier).toBe(16);
    });

    it('honours the opt-out booleans', () => {
        expect(computeStealthConfig({ STEALTH_MODE: 'false' } as NodeJS.ProcessEnv).enabled).toBe(false);
        expect(computeStealthConfig({ STEALTH_TYPING: 'false' } as NodeJS.ProcessEnv).typing).toBe(false);
        expect(computeStealthConfig({ STEALTH_PRESENCE: 'false' } as NodeJS.ProcessEnv).presenceEnabled).toBe(false);
        expect(computeStealthConfig({ STEALTH_MARK_SEEN: 'true' } as NodeJS.ProcessEnv).markSeen).toBe(true);
    });

    it('legacy SIMULATE_TYPING=false disables the typing step (backward compatibility)', () => {
        expect(computeStealthConfig({ SIMULATE_TYPING: 'false' } as NodeJS.ProcessEnv).typing).toBe(false);
        // ...but STEALTH_TYPING does not reach back into the legacy flag semantics
        expect(computeStealthConfig({ SIMULATE_TYPING: 'true' } as NodeJS.ProcessEnv).typing).toBe(true);
    });

    it('parses numeric knobs and falls back to defaults on garbage', () => {
        const config = computeStealthConfig({
            STEALTH_DELAY_MIN_MS: '1500',
            STEALTH_DAILY_CAP: 'abc',
            STEALTH_TYPING_MAX_MS: '-50',
        } as NodeJS.ProcessEnv);
        expect(config.delayMinMs).toBe(1500);
        expect(config.dailyCap).toBe(200); // garbage → default
        expect(config.typingMaxMs).toBe(9000); // negative → default
    });

    it('caps the distraction chance at 1 and the quiet multiplier at >= 1', () => {
        const config = computeStealthConfig({
            STEALTH_DISTRACTION_CHANCE: '5',
            STEALTH_QUIET_DELAY_MULTIPLIER: '0',
        } as NodeJS.ProcessEnv);
        expect(config.distractionChance).toBe(1);
        expect(config.quietDelayMultiplier).toBe(3);
    });
});

describe('resolveStealthConfig', () => {
    it('prefers the ConfigService snapshot when present', () => {
        const snapshot = computeStealthConfig({ STEALTH_DAILY_CAP: '42' } as NodeJS.ProcessEnv);
        const resolved = resolveStealthConfig({ get: (key: string) => (key === 'stealth' ? snapshot : undefined) });
        expect(resolved.dailyCap).toBe(42);
    });

    it('falls back to a live env read without ConfigService', () => {
        const resolved = resolveStealthConfig(undefined);
        expect(resolved).toEqual(computeStealthConfig());
    });
});

describe('mergeStealthOverrides', () => {
    const base = computeStealthConfig({});

    it('applies whitelisted boolean and numeric overrides', () => {
        const merged = mergeStealthOverrides(base, { enabled: false, dailyCap: 500, markSeen: true });
        expect(merged.enabled).toBe(false);
        expect(merged.dailyCap).toBe(500);
        expect(merged.markSeen).toBe(true);
        // untouched keys keep the base value
        expect(merged.newChatDailyCap).toBe(base.newChatDailyCap);
    });

    it('ignores non-whitelisted keys (deployment-protective knobs stay env-only)', () => {
        const merged = mergeStealthOverrides(base, { circuitThreshold: 999, queueMaxSize: 0 } as never);
        expect(merged.circuitThreshold).toBe(base.circuitThreshold);
        expect(merged.queueMaxSize).toBe(base.queueMaxSize);
    });

    it('rejects wrong-typed values instead of coercing them', () => {
        const merged = mergeStealthOverrides(base, { enabled: 'yes', dailyCap: 'lots' } as never);
        expect(merged.enabled).toBe(base.enabled);
        expect(merged.dailyCap).toBe(base.dailyCap);
    });

    it('clamps absurd numbers into sane bounds', () => {
        const merged = mergeStealthOverrides(base, { delayMaxMs: Number.MAX_SAFE_INTEGER, warmupDays: -5 });
        expect(merged.delayMaxMs).toBe(86_400_000);
        expect(merged.warmupDays).toBe(0);
    });

    it('trims and bounds quietHours strings', () => {
        expect(mergeStealthOverrides(base, { quietHours: ' 22:00-08:00 ' }).quietHours).toBe('22:00-08:00');
        expect(mergeStealthOverrides(base, { quietHours: 42 } as never).quietHours).toBe(base.quietHours);
    });

    it('returns the base untouched for non-object overrides', () => {
        expect(mergeStealthOverrides(base, null)).toEqual(base);
        expect(mergeStealthOverrides(base, 'stealth')).toEqual(base);
        expect(mergeStealthOverrides(base, [1, 2])).toEqual(base);
    });

    it('whitelist and DTO stay in sync conceptually (all keys exist on the config type)', () => {
        // Guards against a rename on StealthConfig stranding a session-overridable key.
        for (const key of STEALTH_SESSION_OVERRIDE_KEYS) {
            expect(Object.prototype.hasOwnProperty.call(base, key)).toBe(true);
        }
    });
});
