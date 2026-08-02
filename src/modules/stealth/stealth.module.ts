import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Message } from '../message/entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { StealthController } from './stealth.controller';
import { StealthGuardService } from './stealth-guard.service';
import { StealthPresenceService } from './stealth-presence.service';
import { StealthQueueService } from './stealth-queue.service';

/**
 * Stealth (anti-ban / humanization) layer. Self-contained on purpose: it reads the Session +
 * Message tables directly (per-session overrides, daily counters, new-chat detection) and reaches
 * live engines through the global EngineRegistry, so it never imports SessionModule back and can't
 * create a dependency cycle. MessageModule imports it for the send path.
 */
@Module({
    imports: [TypeOrmModule.forFeature([Session, Message], 'data')],
    controllers: [StealthController],
    providers: [StealthQueueService, StealthGuardService, StealthPresenceService],
    exports: [StealthQueueService, StealthGuardService],
})
export class StealthModule { }
