import {
    clamp,
    gaussianBetween,
    interMessageGapMs,
    isQuietHoursActive,
    parseQuietHours,
    randomBetween,
    readingPauseMs,
    typingDurationMs,
} from './humanizer.util';

describe('humanizer.util', () => {
    describe('clamp', () => {
        it('keeps values inside the range', () => {
            expect(clamp(5, 1, 10)).toBe(5);
            expect(clamp(-3, 1, 10)).toBe(1);
            expect(clamp(30, 1, 10)).toBe(10);
        });
    });

    describe('randomBetween', () => {
        it('stays within [min, max] over many draws', () => {
            for (let i = 0; i < 500; i++) {
                const v = randomBetween(100, 200);
                expect(v).toBeGreaterThanOrEqual(100);
                expect(v).toBeLessThanOrEqual(200);
            }
        });

        it('collapses to min when max <= min', () => {
            expect(randomBetween(50, 50)).toBe(50);
            expect(randomBetween(50, 10)).toBe(50);
        });
    });

    describe('gaussianBetween', () => {
        it('stays within [min, max] and is not metronomic', () => {
            const draws = new Set<number>();
            for (let i = 0; i < 200; i++) {
                const v = gaussianBetween(1000, 3000);
                expect(v).toBeGreaterThanOrEqual(1000);
                expect(v).toBeLessThanOrEqual(3000);
                draws.add(Math.round(v));
            }
            // A fixed interval would produce exactly one value; human jitter must not.
            expect(draws.size).toBeGreaterThan(50);
        });
    });

    describe('typingDurationMs', () => {
        const opts = { minMs: 1200, maxMs: 9000, charsPerSecond: 4.5 };

        it('grows with text length (a longer text types longer)', () => {
            // Compare averages over several draws to tame jitter.
            const avg = (chars: number): number => {
                let sum = 0;
                for (let i = 0; i < 40; i++) sum += typingDurationMs(chars, opts);
                return sum / 40;
            };
            expect(avg(400)).toBeGreaterThan(avg(10));
        });

        it('never exceeds the cap, however long the text', () => {
            for (let i = 0; i < 100; i++) {
                expect(typingDurationMs(100_000, opts)).toBeLessThanOrEqual(opts.maxMs);
            }
        });

        it('never goes below the floor', () => {
            for (let i = 0; i < 100; i++) {
                expect(typingDurationMs(1, opts)).toBeGreaterThanOrEqual(opts.minMs);
            }
        });

        it('returns a short attach pause for caption-less media (chars <= 0)', () => {
            for (let i = 0; i < 100; i++) {
                const v = typingDurationMs(0, opts);
                expect(v).toBeGreaterThanOrEqual(opts.minMs);
                expect(v).toBeLessThanOrEqual(opts.maxMs);
            }
        });

        it('falls back to a sane cps when charsPerSecond is 0/garbage', () => {
            const v = typingDurationMs(50, { minMs: 100, maxMs: 5000, charsPerSecond: 0 });
            expect(v).toBeGreaterThanOrEqual(100);
            expect(v).toBeLessThanOrEqual(5000);
        });
    });

    describe('interMessageGapMs', () => {
        const base = {
            minMs: 2000,
            maxMs: 6000,
            distractionChance: 0,
            distractionMinMs: 8000,
            distractionMaxMs: 20000,
        };

        it('stays inside [minMs, maxMs] without distractions or throttle', () => {
            for (let i = 0; i < 300; i++) {
                const v = interMessageGapMs(base);
                expect(v).toBeGreaterThanOrEqual(2000);
                expect(v).toBeLessThanOrEqual(6000);
            }
        });

        it('applies the throttle multiplier (over-budget traffic gets slower)', () => {
            for (let i = 0; i < 200; i++) {
                const v = interMessageGapMs({ ...base, multiplier: 4 });
                expect(v).toBeGreaterThanOrEqual(8000 - 1); // min * 4 (rounding)
            }
        });

        it('never exceeds the hard cap even with a huge multiplier', () => {
            for (let i = 0; i < 100; i++) {
                expect(interMessageGapMs({ ...base, multiplier: 1000, hardCapMs: 180000 })).toBeLessThanOrEqual(180000);
            }
        });

        it('occasionally produces a distraction pause when the chance is 1', () => {
            for (let i = 0; i < 100; i++) {
                const v = interMessageGapMs({ ...base, distractionChance: 1 });
                expect(v).toBeGreaterThanOrEqual(8000);
                expect(v).toBeLessThanOrEqual(20000);
            }
        });
    });

    describe('readingPauseMs', () => {
        it('stays inside the tight reading window', () => {
            for (let i = 0; i < 200; i++) {
                const v = readingPauseMs();
                expect(v).toBeGreaterThanOrEqual(400);
                expect(v).toBeLessThanOrEqual(1800);
            }
        });
    });

    describe('parseQuietHours', () => {
        it('parses same-day and overnight windows', () => {
            expect(parseQuietHours('13:00-18:30')).toEqual({ startMin: 780, endMin: 1110 });
            expect(parseQuietHours('22:00-08:00')).toEqual({ startMin: 1320, endMin: 480 });
        });

        it('returns null for empty/invalid/zero-length specs', () => {
            expect(parseQuietHours('')).toBeNull();
            expect(parseQuietHours(undefined)).toBeNull();
            expect(parseQuietHours('nope')).toBeNull();
            expect(parseQuietHours('25:00-26:00')).toBeNull();
            expect(parseQuietHours('10:00-10:00')).toBeNull(); // zero-length = disabled, not "always"
        });
    });

    describe('isQuietHoursActive', () => {
        const at = (h: number, m = 0): Date => {
            const d = new Date(2026, 0, 15, h, m);
            return d;
        };

        it('handles a same-day window', () => {
            expect(isQuietHoursActive('13:00-18:00', at(15))).toBe(true);
            expect(isQuietHoursActive('13:00-18:00', at(12, 59))).toBe(false);
            expect(isQuietHoursActive('13:00-18:00', at(18))).toBe(false);
        });

        it('handles an overnight window', () => {
            expect(isQuietHoursActive('22:00-08:00', at(23))).toBe(true);
            expect(isQuietHoursActive('22:00-08:00', at(3))).toBe(true);
            expect(isQuietHoursActive('22:00-08:00', at(7, 59))).toBe(true);
            expect(isQuietHoursActive('22:00-08:00', at(8))).toBe(false);
            expect(isQuietHoursActive('22:00-08:00', at(21, 59))).toBe(false);
        });

        it('is false with quiet hours disabled', () => {
            expect(isQuietHoursActive('', at(3))).toBe(false);
            expect(isQuietHoursActive(undefined, at(3))).toBe(false);
        });
    });
});
