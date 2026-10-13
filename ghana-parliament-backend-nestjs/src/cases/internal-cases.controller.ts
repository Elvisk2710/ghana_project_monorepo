import { BadRequestException, Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { CasePriority, CaseStatus, Role } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { Audit } from '../audit/audit.interceptor';
import { CurrentUser } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import type { RequestStore } from '../common/request-context';
import { Roles } from '../rbac/rbac';
import { CasesService } from './cases.service';

class UpdateDto {
  @IsOptional() @IsString() @MaxLength(50) category?: string;
  @IsOptional() @IsIn(Object.values(CasePriority)) priority?: CasePriority;
}
class AssignDto {
  @ValidateIf((o) => o.assigneeId !== null) @IsUUID() assigneeId!: string | null;
}
class StatusDto {
  @IsIn(Object.values(CaseStatus)) status!: CaseStatus;
}
class NoteDto {
  @IsString() @MinLength(1) @MaxLength(4000) content!: string;
}
class RespondDto {
  @IsOptional() @IsString() @MaxLength(4000) content?: string;
  @IsOptional() @IsUUID() templateId?: string;
}
class EscalationDto {
  @IsBoolean() escalated!: boolean;
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}
class RerouteDto {
  @IsUUID() constituencyId!: string;
}
class ReasonDto {
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}
class TemplateDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MinLength(5) @MaxLength(4000) body?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

const CASE_ROLES = [Role.STAFF, Role.MP, Role.ADMIN] as const;

/**
 * Internal case workflow. Every route is role-gated; access to a specific case is further
 * limited to the caller's constituencies inside CasesService (ADMIN sees all).
 */
@Controller('internal')
export class InternalCasesController {
  constructor(
    private readonly cases: CasesService,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  @Get('cases')
  @Roles(...CASE_ROLES)
  list(@CurrentUser() p: Principal, @Query() q: Record<string, string>) {
    const status = q.status as CaseStatus | undefined;
    if (status && !Object.values(CaseStatus).includes(status)) throw new BadRequestException('Invalid status');
    return this.cases.list(p, {
      status,
      assignee: q.assignee,
      escalated: q.escalated === undefined ? undefined : q.escalated === 'true',
      overdue: q.overdue === 'true',
      search: q.search?.slice(0, 100),
      constituencyId: q.constituencyId,
      cursor: q.cursor,
      limit: q.limit ? parseInt(q.limit, 10) || undefined : undefined,
    });
  }

  @Get('cases/stats')
  @Roles(...CASE_ROLES)
  stats(@CurrentUser() p: Principal) {
    return this.cases.stats(p);
  }

  @Get('cases/:id')
  @Roles(...CASE_ROLES)
  get(@CurrentUser() p: Principal, @Param('id') id: string) {
    return this.cases.detail(p, id);
  }

  @Get('cases/:id/assignees')
  @Roles(...CASE_ROLES)
  assignees(@CurrentUser() p: Principal, @Param('id') id: string) {
    return this.cases.assignees(p, id);
  }

  @Patch('cases/:id')
  @Roles(...CASE_ROLES)
  @Audit({ action: 'case.update', objectType: 'case' })
  update(@CurrentUser() p: Principal, @Param('id') id: string, @Body() dto: UpdateDto) {
    return this.cases.update(p, id, dto);
  }

  @Post('cases/:id/assign')
  @HttpCode(200)
  @Roles(...CASE_ROLES)
  @Audit({ action: 'case.assign', objectType: 'case' })
  assign(@CurrentUser() p: Principal, @Param('id') id: string, @Body() dto: AssignDto) {
    return this.cases.assign(p, id, dto.assigneeId);
  }

  @Post('cases/:id/status')
  @HttpCode(200)
  @Roles(...CASE_ROLES)
  @Audit({ action: 'case.status', objectType: 'case' })
  status(@CurrentUser() p: Principal, @Param('id') id: string, @Body() dto: StatusDto) {
    return this.cases.changeStatus(p, id, dto.status, this.cls.get('correlationId'));
  }

  @Post('cases/:id/notes')
  @HttpCode(201)
  @Roles(...CASE_ROLES)
  @Audit({ action: 'case.note', objectType: 'case' })
  note(@CurrentUser() p: Principal, @Param('id') id: string, @Body() dto: NoteDto) {
    return this.cases.addNote(p, id, dto.content);
  }

  @Post('cases/:id/responses')
  @HttpCode(201)
  @Roles(...CASE_ROLES)
  @Audit({ action: 'case.respond', objectType: 'case' })
  respond(@CurrentUser() p: Principal, @Param('id') id: string, @Body() dto: RespondDto) {
    return this.cases.respond(p, id, dto, this.cls.get('correlationId'));
  }

  @Post('cases/:id/escalation')
  @HttpCode(200)
  @Roles(...CASE_ROLES)
  @Audit({ action: 'case.escalation', objectType: 'case' })
  escalation(@CurrentUser() p: Principal, @Param('id') id: string, @Body() dto: EscalationDto) {
    return this.cases.setEscalation(p, id, dto.escalated, dto.reason);
  }

  @Post('cases/:id/reroute')
  @HttpCode(200)
  @Roles(Role.ADMIN)
  @Audit({ action: 'case.reroute', objectType: 'case' })
  reroute(@CurrentUser() p: Principal, @Param('id') id: string, @Body() dto: RerouteDto) {
    return this.cases.reroute(p, id, dto.constituencyId);
  }

  @Get('cases/:id/export')
  @Roles(...CASE_ROLES)
  @Audit({ action: 'case.export', objectType: 'case' })
  export(@CurrentUser() p: Principal, @Param('id') id: string) {
    return this.cases.exportCase(p, id);
  }

  @Get('cases/:id/attachments/:attachmentId')
  @Roles(...CASE_ROLES)
  async attachment(
    @CurrentUser() p: Principal,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: { set: (h: Record<string, string>) => void; send: (b: Buffer) => void },
  ) {
    const a = await this.cases.attachmentForStaff(p, id, attachmentId);
    res.set({
      'Content-Type': a.mimeType,
      'Content-Disposition': `attachment; filename="${a.filename.replace(/"/g, '')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.send(Buffer.from(a.data!));
  }

  /** Executes an erasure (citizen request or correction). Keeps the non-identifying record. */
  @Post('cases/:id/erase')
  @HttpCode(200)
  @Roles(Role.ADMIN)
  @Audit({ action: 'case.erase', objectType: 'case' })
  erase(@CurrentUser() p: Principal, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.cases.eraseOnRequest(id, dto.reason, p);
  }

  @Post('retention/sweep')
  @HttpCode(200)
  @Roles(Role.ADMIN)
  @Audit({ action: 'case.retention_sweep', objectType: 'case', idParam: 'none' })
  sweep() {
    return this.cases.sweepRetention();
  }

  /** Export of erased cases (no personal data) to keep outside the database; see docs/DISASTER_RECOVERY.md. */
  @Get('erasures/ledger')
  @Roles(Role.ADMIN)
  erasureLedger(@Query('since') since?: string) {
    if (since !== undefined && Number.isNaN(Date.parse(since))) throw new BadRequestException('since must be a date-time');
    return this.cases.erasureLedger(since ? new Date(since) : undefined);
  }

  /** Replays an exported ledger after a restore so erased personal data does not come back. */
  @Post('erasures/reapply')
  @HttpCode(200)
  @Roles(Role.ADMIN)
  reapplyErasures(@CurrentUser() p: Principal, @Body() body: { entries?: { caseId?: unknown }[]; checksum?: string }) {
    return this.cases.reapplyErasures(p, body ?? {});
  }

  @Get('message-templates')
  @Roles(...CASE_ROLES)
  templates(@CurrentUser() p: Principal) {
    return this.cases.templates(p.roles.includes(Role.ADMIN));
  }

  @Post('message-templates')
  @Roles(Role.ADMIN)
  @Audit({ action: 'template.create', objectType: 'template' })
  createTemplate(@Body() dto: TemplateDto) {
    return this.cases.saveTemplate(null, dto);
  }

  @Patch('message-templates/:id')
  @Roles(Role.ADMIN)
  @Audit({ action: 'template.update', objectType: 'template' })
  updateTemplate(@Param('id') id: string, @Body() dto: TemplateDto) {
    return this.cases.saveTemplate(id, dto);
  }
}
