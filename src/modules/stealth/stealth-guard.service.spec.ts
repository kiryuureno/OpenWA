import { Repository } from 'typeorm';
import { Message } from '../message/entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { computeStealthConfig } from './stealth-config';
import { StealthGuardService } from './stealth-guard.service';

const SESSION_ID = 'sess-1';
const CHAT = '628111@c.us';

function buildService(overrides?: {
    dailyCount?: number;
    foundMessage?: boolean;
    sessionCreatedAt?: Date | null;
}): { guard: StealthGuardService; messages: jest.Mocked<Partial<Repository<Message>>> } {
    const messages: jest.Mocked<Partial<Repository<Message>>> = {
        count: jest.fn().mockResolvedValue(overrides?.dailyCount ?? 0),
        createQueryBuilder: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            getOne: jest.fn().mockResolvedValue(overrides?.foundMessage ? { id: 'm1' } : null),
        }),
    };
    const sessions: jest.Mocked<Partial<Repository<Session>>> = {
        findOne: jest.fn().mockResolvedValue(
            overrides?.sessionCreatedAt === null
                ? null
                : { createdAt: overrides?.sessionCreatedAt ?? new Date(Date.now() - 30 * 86_400_000) },
        ),
    };
    const guard = new StealthGuardService(
        messages as Repository<Message>,
        sessions as Repository<Session>,
        undefined,
    );
    return { guard, messages };
}

const config = computeStealthConfig({});

describe('StealthGuardService', () => {
    describe('isNewChat', () => {
        it('is true for a chat with no stored messages, false once sent', async () => {
            const { guard } = buildService({ foundMessage: false });
            expect(await guard.isNewChat(SESSION_ID, CHAT)).toBe(true);
            await guard.noteSent(SESSION_ID, CHAT, true);
            expect(await guard.isNewChat(SESSION_ID, CHAT)).toBe(false);
        });

        it('is false when the messages table already knows the chat', async () => {
            const { guard } = buildService({ foundMessage: true });
            expect(await guard.isNewChat(SESSION_ID, CHAT)).toBe(false);
        });

        it('degrades to "known" (normal pacing) when the DB lookup fails', async () => {
            const { guard, messages } = buildService({ foundMessage: false });
            (messages.createQueryBuilder as jest.Mock).mockImplementation(() => {
                throw new Error('db down');
            });
            expect(await guard.isNewChat(SESSION_ID, 'x@c.us')).toBe(false);
        });
    });

    describe('daily cap throttle (slow-down, never a block)', () => {
        it('multiplier is 1 under the cap and grows past it', async () => {
            const { guard } = buildService({ dailyCount: 0, foundMessage: true });
            const under = await guard.getDelayContext(SESSION_ID, CHAT, config);
            expect(under.multiplier).toBe(1);
            expect(under.reasons).toEqual([]);
        });

        it('crossing the daily cap raises the multiplier progressively', async () => {
            const { guard } = buildService({ dailyCount: 250, foundMessage: true }); // cap 200
            const over = await guard.getDelayContext(SESSION_ID, CHAT, config);
            expect(over.multiplier).toBeGreaterThan(1);
            expect(over.reasons.join(' ')).toContain('daily-cap');
        });

        it('seeds the daily counter from the messages table once per day', async () => {
            const { guard, messages } = buildService({ dailyCount: 77, foundMessage: true });
            const stats = await guard.getStats(SESSION_ID, config);
            expect(stats.sentToday).toBe(77);
            await guard.getStats(SESSION_ID, config);
            expect(messages.count).toHaveBeenCalledTimes(1); // cached for the rest of the day
        });
    });

    describe('new-chat budget + warm-up ramp', () => {
        it('throttles first-contact sends once the daily new-chat budget is spent', async () => {
            const tight = computeStealthConfig({ STEALTH_NEW_CHAT_DAILY_CAP: '2', STEALTH_WARMUP_DAYS: '0' } as NodeJS.ProcessEnv);
            const { guard } = buildService({ foundMessage: false });
            await guard.noteSent(SESSION_ID, 'a@c.us', true);
            await guard.noteSent(SESSION_ID, 'b@c.us', true);
            const ctx = await guard.getDelayContext(SESSION_ID, 'c@c.us', tight);
            expect(ctx.isNewChat).toBe(true);
            expect(ctx.multiplier).toBeGreaterThan(1);
            expect(ctx.reasons.join(' ')).toContain('new-chat-budget');
        });

        it('a young session gets a smaller warm-up budget than an established one', () => {
            const { guard: young } = buildService({ sessionCreatedAt: new Date(Date.now() - 1 * 86_400_000) });
            const { guard: old } = buildService({ sessionCreatedAt: new Date(Date.now() - 60 * 86_400_000) });
            // Access the public surface via stats: budget differs by session age.
            return Promise.all([young.getStats('y', config), old.getStats('o', config)]).then(([youngStats, oldStats]) => {
                expect(youngStats.newChatBudgetToday).toBeLessThan(oldStats.newChatBudgetToday);
                expect(oldStats.newChatBudgetToday).toBe(config.newChatDailyCap);
            });
        });
    });

    describe('repeated-content detection', () => {
        it('throttles the same payload fanning out to many chats', async () => {
            const { guard } = buildService({ foundMessage: true });
            const key = 'fp-1';
            for (let i = 0; i < 8; i++) {
                await guard.noteSent(SESSION_ID, `chat${i}@c.us`, false, key);
            }
            const ctx = await guard.getDelayContext(SESSION_ID, 'chat9@c.us', config, key);
            expect(ctx.multiplier).toBeGreaterThan(1);
            expect(ctx.reasons).toContain('repeated-content');
        });

        it('does not flag the same payload to the SAME chat (a conversation)', async () => {
            const { guard } = buildService({ foundMessage: true });
            const key = 'fp-2';
            for (let i = 0; i < 20; i++) {
                await guard.noteSent(SESSION_ID, CHAT, false, key);
            }
            const ctx = await guard.getDelayContext(SESSION_ID, CHAT, config, key);
            expect(ctx.reasons).not.toContain('repeated-content');
        });
    });

    describe('quiet hours', () => {
        it('multiplies the gap while the quiet window is active', async () => {
            const now = new Date();
            const spec = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}-23:59`;
            const quiet = computeStealthConfig({ STEALTH_QUIET_HOURS: spec } as NodeJS.ProcessEnv);
            const { guard } = buildService({ foundMessage: true });
            const ctx = await guard.getDelayContext(SESSION_ID, CHAT, quiet);
            expect(ctx.reasons).toContain('quiet-hours');
            expect(ctx.multiplier).toBe(quiet.quietDelayMultiplier);
        });
    });

    describe('circuit breaker', () => {
        it('trips after the threshold of consecutive failures and holds the queue', () => {
            const { guard } = buildService();
            expect(guard.getCircuitRemainingMs(SESSION_ID)).toBe(0);
            for (let i = 0; i < config.circuitThreshold; i++) {
                guard.noteFailure(SESSION_ID, config);
            }
            expect(guard.getCircuitRemainingMs(SESSION_ID)).toBeGreaterThan(0);
        });

        it('a success resets the failure streak', async () => {
            const { guard } = buildService({ foundMessage: true });
            for (let i = 0; i < config.circuitThreshold - 1; i++) {
                guard.noteFailure(SESSION_ID, config);
            }
            await guard.noteSent(SESSION_ID, CHAT, false);
            guard.noteFailure(SESSION_ID, config);
            expect(guard.getCircuitRemainingMs(SESSION_ID)).toBe(0);
        });

        it('does not re-trip while already broken (single cooldown window)', async () => {
            const { guard } = buildService();
            for (let i = 0; i < config.circuitThreshold; i++) {
                guard.noteFailure(SESSION_ID, config);
            }
            const first = guard.getCircuitRemainingMs(SESSION_ID);
            guard.noteFailure(SESSION_ID, config);
            const second = guard.getCircuitRemainingMs(SESSION_ID);
            expect(second).toBeLessThanOrEqual(first);
        });
    });

    describe('resetSession', () => {
        it('drops all runtime state for the session', async () => {
            const { guard } = buildService({ dailyCount: 250, foundMessage: true });
            await guard.getDelayContext(SESSION_ID, CHAT, config);
            guard.resetSession(SESSION_ID);
            expect(guard.getLastSentAt(SESSION_ID)).toBe(0);
        });
    });
});
