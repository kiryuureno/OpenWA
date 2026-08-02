import { Body, Controller, Get, NotFoundException, Param, Patch } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Session } from '../session/entities/session.entity';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { UpdateStealthConfigDto } from './dto/stealth-config.dto';
import { STEALTH_SESSION_OVERRIDE_KEYS, StealthSessionOverrides } from './stealth-config';
import { StealthGuardService } from './stealth-guard.service';
import { StealthQueueService } from './stealth-queue.service';

/**
 * Stealth (anti-ban) configuration and runtime stats, per session.
 *
 * Overrides are stored in the Session row's `config.stealth` JSON and merged over the env-level
 * STEALTH_* config on read (and on every send). Only the whitelisted keys survive the merge —
 * the same subset UpdateStealthConfigDto exposes.
 */
@ApiTags('sessions')
@Controller('sessions/:sessionId/stealth')
export class StealthController {
    constructor(
        private readonly queue: StealthQueueService,
        private readonly guard: StealthGuardService,
        @InjectRepository(Session, 'data')
        private readonly sessionRepository: Repository<Session>,
    ) { }

    @Get()
    @ApiOperation({
        summary: 'Effective stealth config for a session (env STEALTH_* merged with per-session overrides)',
    })
    @ApiParam({ name: 'sessionId', description: 'Session ID' })
    @ApiResponse({ status: 200, description: 'Effective config + the overrides currently applied' })
    @ApiResponse({ status: 404, description: 'Session not found' })
    async getConfig(@Param('sessionId') sessionId: string) {
        const session = await this.requireSession(sessionId);
        const overrides = (session.config as Record<string, unknown> | undefined)?.stealth ?? {};
        const effective = await this.queue.getSessionConfig(sessionId);
        return { sessionId, effective, overrides };
    }

    @Patch()
    @RequireRole(ApiKeyRole.OPERATOR)
    @ApiOperation({
        summary:
            'Update per-session stealth overrides. Only the supplied keys are merged; omit a key to keep its ' +
            'current value. Overrides win over the STEALTH_* environment config for this session only.',
    })
    @ApiParam({ name: 'sessionId', description: 'Session ID' })
    @ApiResponse({ status: 200, description: 'Overrides updated; returns the effective config' })
    @ApiResponse({ status: 404, description: 'Session not found' })
    async updateConfig(@Param('sessionId') sessionId: string, @Body() dto: UpdateStealthConfigDto) {
        const session = await this.requireSession(sessionId);

        // Keep only whitelisted keys that were actually supplied (undefined = not part of the PATCH).
        const incoming = dto as unknown as Record<string, unknown>;
        const current = ((session.config as Record<string, unknown> | undefined)?.stealth ?? {}) as Record<string, unknown>;
        const next: Record<string, unknown> = { ...current };
        for (const key of STEALTH_SESSION_OVERRIDE_KEYS) {
            if (incoming[key] !== undefined) next[key] = incoming[key];
        }

        session.config = { ...(session.config ?? {}), stealth: next } as Session['config'];
        await this.sessionRepository.save(session);
        this.queue.invalidateSessionConfig(sessionId);

        const effective = await this.queue.getSessionConfig(sessionId);
        return { sessionId, effective, overrides: next as StealthSessionOverrides };
    }

    @Get('stats')
    @ApiOperation({
        summary:
            'Runtime stealth stats: today\'s counters vs budgets, queue depth, circuit-breaker state. ' +
            'Counters are per-process, with sentToday seeded from the messages table.',
    })
    @ApiParam({ name: 'sessionId', description: 'Session ID' })
    @ApiResponse({ status: 200, description: 'Runtime stats' })
    @ApiResponse({ status: 404, description: 'Session not found' })
    async getStats(@Param('sessionId') sessionId: string) {
        await this.requireSession(sessionId);
        const config = await this.queue.getSessionConfig(sessionId);
        const stats = await this.guard.getStats(sessionId, config);
        return {
            sessionId,
            ...stats,
            queueDepth: this.queue.getQueueDepth(sessionId),
            circuitHoldRemainingMs: this.guard.getCircuitRemainingMs(sessionId),
        };
    }

    private async requireSession(sessionId: string): Promise<Session> {
        const session = await this.sessionRepository.findOne({ where: { id: sessionId } });
        if (!session) {
            throw new NotFoundException(`Session '${sessionId}' not found`);
        }
        return session;
    }
}
