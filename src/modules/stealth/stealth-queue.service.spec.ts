import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { Session } from '../session/entities/session.entity';
import { StealthGuardService } from './stealth-guard.service';
import { StealthQueueService, StealthSendRequest } from './stealth-queue.service';

const SESSION_ID = 'sess-1';
const CHAT = '628111@c.us';

// Keep every humanized delay at ~0 so the pipeline runs in real time without slowing the suite.
const FAST_ENV: Record<string, string> = {
    STEALTH_TYPING_MIN_MS: '0',
    STEALTH_TYPING_MAX_MS: '1',
    STEALTH_READING_MIN_MS: '0',
    STEALTH_READING_MAX_MS: '1',
    STEALTH_DELAY_MIN_MS: '0',
    STEALTH_DELAY_MAX_MS: '1',
    STEALTH_NEW_CHAT_DELAY_MIN_MS: '0',
    STEALTH_NEW_CHAT_DELAY_MAX_MS: '1',
    STEALTH_DISTRACTION_CHANCE: '0',
    STEALTH_RECONNECT_GRACE_MIN_MS: '0',
    STEALTH_RECONNECT_GRACE_MAX_MS: '0',
};

function createMockEngine() {
    return {
        sendTextMessage: jest.fn().mockResolvedValue({ id: 'wa-1', timestamp: 1706868000 }),
        sendChatState: jest.fn().mockResolvedValue(undefined),
        sendSeen: jest.fn().mockResolvedValue(true),
        sendPresenceAvailable: jest.fn().mockResolvedValue(undefined),
    };
}

describe('StealthQueueService', () => {
    let queue: StealthQueueService;
    let engines: EngineRegistry;
    let mockEngine: ReturnType<typeof createMockEngine>;
    let guard: jest.Mocked<Partial<StealthGuardService>>;
    let sessionRepository: jest.Mocked<Partial<Repository<Session>>>;
    let savedEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
        savedEnv = { ...process.env };
        Object.assign(process.env, FAST_ENV);
        delete process.env.STEALTH_MODE;
        delete process.env.STEALTH_QUEUE_MAX_SIZE;

        mockEngine = createMockEngine();
        engines = new EngineRegistry();
        engines.set(SESSION_ID, mockEngine as unknown as IWhatsAppEngine);

        guard = {
            getCircuitRemainingMs: jest.fn().mockReturnValue(0),
            getDelayContext: jest.fn().mockResolvedValue({ isNewChat: false, multiplier: 1, reasons: [] }),
            noteSent: jest.fn().mockResolvedValue(undefined),
            noteFailure: jest.fn(),
            getLastSentAt: jest.fn().mockReturnValue(0),
            resetSession: jest.fn(),
        };
        sessionRepository = {
            findOne: jest.fn().mockResolvedValue({ id: SESSION_ID, config: {} }),
        };

        queue = new StealthQueueService(
            engines,
            guard as StealthGuardService,
            sessionRepository as Repository<Session>,
            undefined,
        );
    });

    afterEach(() => {
        queue.onModuleDestroy();
        process.env = savedEnv;
    });

    const req = (overrides?: Partial<StealthSendRequest>): StealthSendRequest => ({
        chatId: CHAT,
        kind: 'text',
        textLength: 5,
        ...overrides,
    });

    describe('humanized pipeline (default)', () => {
        it('marks presence online, shows typing, then sends and resolves with the engine result', async () => {
            const result = await queue.executeSend(SESSION_ID, req(), eng => eng.sendTextMessage(CHAT, 'hello'));

            expect(result).toEqual({ id: 'wa-1', timestamp: 1706868000 });
            expect(mockEngine.sendPresenceAvailable).toHaveBeenCalled();
            expect(mockEngine.sendChatState).toHaveBeenCalledWith(CHAT, 'typing');
            expect(mockEngine.sendTextMessage).toHaveBeenCalledWith(CHAT, 'hello');
            // Order: presence/typing strictly BEFORE the send.
            const presenceOrder = mockEngine.sendPresenceAvailable.mock.invocationCallOrder[0];
            const typingOrder = mockEngine.sendChatState.mock.invocationCallOrder[0];
            const sendOrder = mockEngine.sendTextMessage.mock.invocationCallOrder[0];
            expect(presenceOrder).toBeLessThan(sendOrder);
            expect(typingOrder).toBeLessThan(sendOrder);
            expect(guard.noteSent).toHaveBeenCalledWith(SESSION_ID, CHAT, false, undefined);
        });

        it('shows "recording" instead of "typing" for a voice note', async () => {
            await queue.executeSend(SESSION_ID, req({ kind: 'voice' }), eng => eng.sendTextMessage(CHAT, 'v'));
            expect(mockEngine.sendChatState).toHaveBeenCalledWith(CHAT, 'recording');
        });

        it('sendSeen runs before the send when markSeen is enabled per session override', async () => {
            sessionRepository.findOne = jest.fn().mockResolvedValue({
                id: SESSION_ID,
                config: { stealth: { markSeen: true } },
            });
            queue.invalidateSessionConfig(SESSION_ID);
            await queue.executeSend(SESSION_ID, req(), eng => eng.sendTextMessage(CHAT, 'hello'));
            expect(mockEngine.sendSeen).toHaveBeenCalledWith(CHAT);
            const seenOrder = mockEngine.sendSeen.mock.invocationCallOrder[0];
            const sendOrder = mockEngine.sendTextMessage.mock.invocationCallOrder[0];
            expect(seenOrder).toBeLessThan(sendOrder);
        });

        it('records a failure on the guard and rethrows the engine error to the caller', async () => {
            const boom = new Error('engine exploded');
            await expect(queue.executeSend(SESSION_ID, req(), () => Promise.reject(boom))).rejects.toBe(boom);
            expect(guard.noteFailure).toHaveBeenCalled();
            expect(guard.noteSent).not.toHaveBeenCalled();
        });

        it('holds the send while the circuit breaker is open', async () => {
            guard.getCircuitRemainingMs = jest.fn().mockReturnValue(30);
            const started = Date.now();
            await queue.executeSend(SESSION_ID, req(), eng => eng.sendTextMessage(CHAT, 'hello'));
            expect(Date.now() - started).toBeGreaterThanOrEqual(25);
            expect(mockEngine.sendTextMessage).toHaveBeenCalled();
        });
    });

    describe('direct path (humanize: false or STEALTH_MODE=false)', () => {
        it('humanize:false calls the engine immediately with no presence/typing', async () => {
            await queue.executeSend(SESSION_ID, req({ humanize: false }), eng => eng.sendTextMessage(CHAT, 'fast'));
            expect(mockEngine.sendTextMessage).toHaveBeenCalledWith(CHAT, 'fast');
            expect(mockEngine.sendPresenceAvailable).not.toHaveBeenCalled();
            expect(mockEngine.sendChatState).not.toHaveBeenCalled();
        });

        it('STEALTH_MODE=false disables the pipeline globally', async () => {
            process.env.STEALTH_MODE = 'false';
            queue.invalidateSessionConfig(SESSION_ID);
            await queue.executeSend(SESSION_ID, req(), eng => eng.sendTextMessage(CHAT, 'fast'));
            expect(mockEngine.sendChatState).not.toHaveBeenCalled();
        });

        it('the direct path rejects with the documented 400 when the session is not active', async () => {
            await expect(queue.executeSend('ghost-session', req({ humanize: false }), eng => eng.sendTextMessage(CHAT, 'x'))).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });
    });

    describe('per-session serialization', () => {
        it('sends on one session are serialized (no interleaving)', async () => {
            const events: string[] = [];
            const tracked = (label: string) => async (eng: IWhatsAppEngine) => {
                events.push(`start:${label}`);
                await new Promise(resolve => setTimeout(resolve, 5));
                events.push(`end:${label}`);
                return eng.sendTextMessage(CHAT, label);
            };
            await Promise.all([
                queue.executeSend(SESSION_ID, req(), tracked('a')),
                queue.executeSend(SESSION_ID, req(), tracked('b')),
                queue.executeSend(SESSION_ID, req(), tracked('c')),
            ]);
            expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
        });

        it('different sessions drain independently', async () => {
            const other = createMockEngine();
            engines.set('sess-2', other as unknown as IWhatsAppEngine);
            sessionRepository.findOne = jest.fn().mockImplementation(({ where: { id } }: { where: { id: string } }) =>
                Promise.resolve({ id, config: {} }),
            );
            const events: string[] = [];
            const tracked = (label: string) => async (eng: IWhatsAppEngine) => {
                events.push(`start:${label}`);
                await new Promise(resolve => setTimeout(resolve, 10));
                events.push(`end:${label}`);
                return eng.sendTextMessage(CHAT, label);
            };
            await Promise.all([
                queue.executeSend(SESSION_ID, req(), tracked('s1')),
                queue.executeSend('sess-2', req(), tracked('s2')),
            ]);
            // s2 must NOT wait for s1 to finish (independent queues).
            expect(events.indexOf('start:s2')).toBeLessThan(events.indexOf('end:s1'));
        });

        it('conversational traffic jumps ahead of background (bulk) traffic', async () => {
            let releaseFirst!: () => void;
            const blocker = new Promise<void>(resolve => {
                releaseFirst = resolve;
            });
            const order: string[] = [];
            // First job occupies the drain; the next two park behind it.
            const first = queue.executeSend(SESSION_ID, req(), async eng => {
                await blocker;
                order.push('first');
                return eng.sendTextMessage(CHAT, 'first');
            });
            const bulk = queue.executeSend(SESSION_ID, req({ background: true }), async eng => {
                order.push('bulk');
                return eng.sendTextMessage(CHAT, 'bulk');
            });
            const conversational = queue.executeSend(SESSION_ID, req(), async eng => {
                order.push('conversational');
                return eng.sendTextMessage(CHAT, 'conversational');
            });
            releaseFirst();
            await Promise.all([first, bulk, conversational]);
            expect(order).toEqual(['first', 'conversational', 'bulk']);
        });
    });

    describe('backpressure', () => {
        it('refuses with 503 once the per-session pending cap is reached', async () => {
            process.env.STEALTH_QUEUE_MAX_SIZE = '1';
            queue.invalidateSessionConfig(SESSION_ID);
            let release!: () => void;
            const blocker = new Promise<void>(resolve => {
                release = resolve;
            });
            const first = queue.executeSend(SESSION_ID, req(), async eng => {
                await blocker;
                return eng.sendTextMessage(CHAT, 'held');
            });
            // The first job is mid-drain; one pending slot remains... which the second takes.
            const second = queue.executeSend(SESSION_ID, req(), eng => eng.sendTextMessage(CHAT, 'queued'));
            await expect(queue.executeSend(SESSION_ID, req(), eng => eng.sendTextMessage(CHAT, 'overflow'))).rejects.toBeInstanceOf(
                ServiceUnavailableException,
            );
            release();
            await Promise.all([first, second]);
        });
    });

    describe('queue depth + stats surface', () => {
        it('reports pending jobs while held and zero after draining', async () => {
            let release!: () => void;
            const blocker = new Promise<void>(resolve => {
                release = resolve;
            });
            const held = queue.executeSend(SESSION_ID, req(), async eng => {
                await blocker;
                return eng.sendTextMessage(CHAT, 'held');
            });
            const pending = queue.executeSend(SESSION_ID, req(), eng => eng.sendTextMessage(CHAT, 'next'));
            // executeSend awaits the session config BEFORE enqueuing, so the job only lands in the
            // queue on the next tick — the depth assert must wait for that enqueue to happen.
            await new Promise(resolve => setImmediate(resolve));
            expect(queue.getQueueDepth(SESSION_ID)).toBe(1);
            release();
            await Promise.all([held, pending]);
            expect(queue.getQueueDepth(SESSION_ID)).toBe(0);
        });
    });

    describe('reconnect grace', () => {
        it('holds sends briefly right after the session becomes READY', async () => {
            process.env.STEALTH_RECONNECT_GRACE_MIN_MS = '30';
            process.env.STEALTH_RECONNECT_GRACE_MAX_MS = '30';
            queue.invalidateSessionConfig(SESSION_ID);
            queue.noteSessionReady(SESSION_ID);
            const started = Date.now();
            await queue.executeSend(SESSION_ID, req(), eng => eng.sendTextMessage(CHAT, 'hello'));
            expect(Date.now() - started).toBeGreaterThanOrEqual(25);
        });
    });
});
