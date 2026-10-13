import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { Equals, IsEmail, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Public } from '../auth/decorators';
import { rate } from '../common/rate';
import { CasesService } from './cases.service';
import { MAX_ATTACHMENT_BYTES } from './scanner';

class ContactDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsEmail() @MaxLength(200) email?: string;
  @IsOptional() @Matches(/^\+?[0-9][0-9 \-]{7,18}$/, { message: 'phone must be a valid phone number' }) phone?: string;
  @IsIn(['EMAIL', 'SMS', 'NONE']) channel!: 'EMAIL' | 'SMS' | 'NONE';
}

class SubmitCaseDto {
  @IsUUID() constituencyId!: string;
  @IsString() @MaxLength(50) category!: string;
  @IsString() @MinLength(3) @MaxLength(120) title!: string;
  @IsString() @MinLength(10) @MaxLength(2000) description!: string;
  @IsOptional() @IsString() @MaxLength(200) locationText?: string;
  @IsOptional() @IsString() @MaxLength(10) preferredLanguage?: string;
  @Equals(true, { message: 'consent must be given' }) consent!: boolean;
  @ValidateNested() @Type(() => ContactDto) contact!: ContactDto;
  @IsOptional() @IsUUID() submissionKey?: string;
}

class SuggestDto {
  @IsString() @MinLength(10) @MaxLength(2000) description!: string;
}

class ReplyDto {
  @IsString() @MinLength(1) @MaxLength(2000) content!: string;
}

const TOKEN = 'x-case-token';

/**
 * Public citizen case API. Anonymous: the citizen proves ownership with the reference plus the
 * tracking code returned at submission (header X-Case-Token). Internal data is never returned.
 */
@Public()
@Controller('public')
export class PublicCasesController {
  constructor(private readonly cases: CasesService) {}

  @Get('case-categories')
  @Throttle(rate(60))
  categories() {
    return this.cases.categories();
  }

  /** Suggestion only: shown to the citizen beside their own text, never applied automatically. */
  @Post('cases/suggest')
  @HttpCode(200)
  @Throttle(rate(20))
  suggest(@Body() dto: SuggestDto) {
    return this.cases.suggestFor(dto.description);
  }

  @Post('cases')
  @HttpCode(201)
  @Throttle(rate(5))
  submit(@Body() dto: SubmitCaseDto) {
    return this.cases.submit(dto);
  }

  @Get('cases/:reference')
  @Throttle(rate(60))
  view(@Param('reference') reference: string, @Headers(TOKEN) token?: string) {
    return this.cases.publicView(reference, token);
  }

  @Post('cases/:reference/messages')
  @HttpCode(201)
  @Throttle(rate(10))
  reply(@Param('reference') reference: string, @Headers(TOKEN) token: string | undefined, @Body() dto: ReplyDto) {
    return this.cases.citizenReply(reference, token, dto.content);
  }

  @Post('cases/:reference/attachments')
  @HttpCode(201)
  @Throttle(rate(10))
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } }))
  attach(@Param('reference') reference: string, @Headers(TOKEN) token: string | undefined, @UploadedFile() file: { buffer: Buffer; originalname: string; mimetype: string } | undefined) {
    if (!file) throw new BadRequestException('A file is required (multipart field "file")');
    return this.cases.addAttachment(reference, token, file);
  }

  @Get('cases/:reference/attachments/:attachmentId')
  @Throttle(rate(30))
  async download(
    @Param('reference') reference: string,
    @Param('attachmentId') attachmentId: string,
    @Headers(TOKEN) token: string | undefined,
    @Res() res: { set: (h: Record<string, string>) => void; send: (b: Buffer) => void },
  ) {
    const a = await this.cases.citizenAttachment(reference, token, attachmentId);
    res.set({
      'Content-Type': a.mimeType,
      'Content-Disposition': `attachment; filename="${a.filename.replace(/"/g, '')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.send(Buffer.from(a.data!));
  }

  @Get('cases/:reference/export')
  @Throttle(rate(5))
  export(@Param('reference') reference: string, @Headers(TOKEN) token?: string) {
    return this.cases.citizenExport(reference, token);
  }

  @Post('cases/:reference/erasure-request')
  @HttpCode(202)
  @Throttle(rate(3))
  erasure(@Param('reference') reference: string, @Headers(TOKEN) token?: string) {
    return this.cases.requestErasure(reference, token);
  }
}
