import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { MeetingStatus, Role } from '@prisma/client';
import { IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Public, CurrentUser } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { rate } from '../common/rate';
import { Roles } from '../rbac/rbac';
import { MeetingsService } from './meetings.service';

const SCOPED = [Role.STAFF, Role.MP, Role.ADMIN] as const;

class AvailabilityWindowDto {
  @IsInt() @Min(0) @Max(6) dayOfWeek!: number;
  @IsString() startTime!: string;
  @IsString() endTime!: string;
}

class SetAvailabilityDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => AvailabilityWindowDto) windows!: AvailabilityWindowDto[];
}

class RequestMeetingDto {
  @IsUUID() mpId!: string;
  @IsString() @MaxLength(120) requestedName!: string;
  @IsString() @MaxLength(300) topic!: string;
  @IsISO8601() requestedSlot!: string;
  @IsOptional() @IsInt() @Min(10) @Max(120) durationMinutes?: number;
  @IsOptional() @IsString() citizenContactRef?: string;
  @IsOptional() @IsUUID() caseId?: string;
}

class DecideMeetingDto {
  @IsIn(['CONFIRMED', 'DECLINED']) decision!: 'CONFIRMED' | 'DECLINED';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/** Citizen-facing: request a meeting, and read an MP's published availability. */
@Controller('public/meetings')
export class PublicMeetingsController {
  constructor(private readonly meetings: MeetingsService) {}

  @Public()
  @Throttle(rate(5))
  @Post()
  request(@Body() dto: RequestMeetingDto) {
    return this.meetings.request(dto);
  }
}

/** Staff/MP console: manage availability windows and decide on meeting requests. */
@Controller('internal/mps/:mpId/meetings')
export class InternalMeetingsController {
  constructor(private readonly meetings: MeetingsService) {}

  @Get()
  @Roles(...SCOPED)
  list(@CurrentUser() p: Principal, @Param('mpId') mpId: string, @Query('status') status?: MeetingStatus) {
    return this.meetings.list(p, mpId, status);
  }

  @Get('availability')
  @Roles(...SCOPED)
  getAvailability(@CurrentUser() p: Principal, @Param('mpId') mpId: string) {
    return this.meetings.listAvailability(p, mpId);
  }

  @Post('availability')
  @Roles(...SCOPED)
  setAvailability(@CurrentUser() p: Principal, @Param('mpId') mpId: string, @Body() dto: SetAvailabilityDto) {
    return this.meetings.setAvailability(p, mpId, dto.windows);
  }
}

@Controller('internal/meetings')
export class InternalMeetingDecisionController {
  constructor(private readonly meetings: MeetingsService) {}

  @Patch(':id')
  @Roles(...SCOPED)
  decide(@CurrentUser() p: Principal, @Param('id') id: string, @Body() dto: DecideMeetingDto) {
    return this.meetings.decide(p, id, dto.decision, dto.note);
  }

  @Patch(':id/cancel')
  @Roles(...SCOPED)
  cancel(@CurrentUser() p: Principal, @Param('id') id: string) {
    return this.meetings.cancel(p, id);
  }
}
