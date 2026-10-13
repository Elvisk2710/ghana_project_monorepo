import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FeedbackSentiment, Role } from '@prisma/client';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Public } from '../auth/decorators';
import { rate } from '../common/rate';
import { Roles } from '../rbac/rbac';
import { BillFeedbackService } from './bill-feedback.service';

class SubmitFeedbackDto {
  @IsIn(['POSITIVE', 'NEUTRAL', 'NEGATIVE']) sentiment!: FeedbackSentiment;
  @IsOptional() @IsString() @MaxLength(1000) comment?: string;
}

@Controller('public/bills/:id/feedback')
export class PublicBillFeedbackController {
  constructor(private readonly feedback: BillFeedbackService) {}

  @Public()
  @Throttle(rate(10))
  @Post()
  submit(@Param('id') id: string, @Body() dto: SubmitFeedbackDto) {
    return this.feedback.submit(id, dto.sentiment, dto.comment);
  }
}

@Controller('internal/bills/:id/feedback')
export class InternalBillFeedbackController {
  constructor(private readonly feedback: BillFeedbackService) {}

  @Get()
  @Roles(Role.STAFF, Role.MP, Role.REVIEWER, Role.ADMIN)
  summary(@Param('id') id: string) {
    return this.feedback.summary(id);
  }
}
