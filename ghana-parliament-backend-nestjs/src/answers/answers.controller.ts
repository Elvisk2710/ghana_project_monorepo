import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { rate } from '../common/rate';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Public } from '../auth/decorators';
import { RuntimeConfigService } from '../governance/runtime-config';
import { AnswersService, REPORT_TYPES } from './answers.service';
import { LANGUAGES } from './languages';
import { MAX_COMMENT_CHARS, MAX_QUESTION_CHARS } from './safety';

class AskDto {
  @IsString() @MinLength(1) @MaxLength(MAX_QUESTION_CHARS) question!: string;
  @IsOptional() @IsString() @MaxLength(10) language?: string;
  @IsOptional() @IsString() @MaxLength(100) sessionRef?: string;
}

class FeedbackDto {
  @IsOptional() @IsBoolean() helpful?: boolean;
  @IsOptional() @IsIn([...REPORT_TYPES]) reportType?: (typeof REPORT_TYPES)[number];
  @IsOptional() @IsString() @MaxLength(MAX_COMMENT_CHARS) comment?: string;
}

/** Public Ask Parliament API. Anonymous; stricter rate limits than the rest of the API. */
@Public()
@Controller('public')
export class AnswersController {
  constructor(
    private readonly answers: AnswersService,
    private readonly runtime: RuntimeConfigService,
  ) {}

  @Get('languages')
  languages() {
    return LANGUAGES;
  }

  /** Lets the public app say plainly when answering is paused, before a citizen types a question. */
  @Get('answering-status')
  @Throttle(rate(60))
  async answeringStatus() {
    const s = await this.runtime.answering();
    return { enabled: s.enabled, message: s.enabled ? null : 'Ask Parliament is paused while we check a problem. You can still search and read the Hansards.' };
  }

  @Post('answers')
  @HttpCode(200)
  @Throttle(rate(10))
  async ask(@Body() dto: AskDto, @Res({ passthrough: true }) res: { status: (c: number) => void }) {
    const result = await this.answers.ask(dto);
    if (result.status === 'service_unavailable' || result.status === 'answering_paused') res.status(503);
    return result;
  }

  @Get('answers/:id')
  @Throttle(rate(60))
  get(@Param('id') id: string) {
    return this.answers.get(id);
  }

  @Post('answers/:id/feedback')
  @HttpCode(201)
  @Throttle(rate(20))
  feedback(@Param('id') id: string, @Body() dto: FeedbackDto) {
    return this.answers.addFeedback(id, dto);
  }
}
