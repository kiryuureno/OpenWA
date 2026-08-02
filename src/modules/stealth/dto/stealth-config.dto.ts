import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { ToStrictBoolean } from '../../../common/utils/strict-boolean';

/**
 * Per-session stealth overrides (PATCH /api/sessions/:id/stealth). All fields optional — only the
 * keys present are merged into the session's `config.stealth`. Mirrors the whitelisted subset in
 * stealth-config.ts (STEALTH_SESSION_OVERRIDE_KEYS); a field added here must exist there too, or
 * it is silently dropped by the merge.
 */
export class UpdateStealthConfigDto {
    @ApiPropertyOptional({ description: 'Master switch for the humanization pipeline on this session' })
    @ToStrictBoolean()
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;

    @ApiPropertyOptional({ description: 'Typing/recording indicator before sends' })
    @ToStrictBoolean()
    @IsOptional()
    @IsBoolean()
    typing?: boolean;

    @ApiPropertyOptional({ description: 'Mark the chat as read before replying (sendSeen)' })
    @ToStrictBoolean()
    @IsOptional()
    @IsBoolean()
    markSeen?: boolean;

    @ApiPropertyOptional({ description: 'Periodic "online" presence flips around real activity' })
    @ToStrictBoolean()
    @IsOptional()
    @IsBoolean()
    presenceEnabled?: boolean;

    @ApiPropertyOptional({ description: 'Soft daily outbound cap (0 = unlimited). Crossing it only raises the throttle' })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(100000)
    dailyCap?: number;

    @ApiPropertyOptional({ description: 'Soft daily cap on first-contact chats (0 = unlimited)' })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(10000)
    newChatDailyCap?: number;

    @ApiPropertyOptional({ description: 'Warm-up ramp days for young sessions (0 = disabled)' })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(90)
    warmupDays?: number;

    @ApiPropertyOptional({ description: 'Quiet-hours window "HH:MM-HH:MM" (local); empty disables', example: '22:00-08:00' })
    @IsOptional()
    @IsString()
    @Matches(/^(\d{1,2}:\d{2}-\d{1,2}:\d{2})?$/, { message: 'quietHours must look like "22:00-08:00" (or be empty)' })
    quietHours?: string;

    @ApiPropertyOptional({ description: 'Normal inter-message gap floor (ms)' })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(120000)
    delayMinMs?: number;

    @ApiPropertyOptional({ description: 'Normal inter-message gap ceiling (ms)' })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(300000)
    delayMaxMs?: number;

    @ApiPropertyOptional({ description: 'First-contact gap floor (ms)' })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(300000)
    newChatDelayMinMs?: number;

    @ApiPropertyOptional({ description: 'First-contact gap ceiling (ms)' })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(600000)
    newChatDelayMaxMs?: number;

    @ApiPropertyOptional({ description: 'Typing-simulation floor (ms)' })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(60000)
    typingMinMs?: number;

    @ApiPropertyOptional({ description: 'Typing-simulation cap (ms)' })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(120000)
    typingMaxMs?: number;
}
