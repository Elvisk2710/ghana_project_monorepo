import { BadRequestException, Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApprovalDecision, BillStage, Role, SittingStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Audit } from '../audit/audit.interceptor';
import { CurrentUser } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { Roles } from '../rbac/rbac';
import { GATED, GatedType, OperationsService } from './operations.service';

const READ = [Role.STAFF, Role.MP, Role.REVIEWER, Role.ADMIN] as const;
const WRITE = [Role.STAFF, Role.ADMIN] as const;
const enumOf = <T extends object>(e: T, v: string | undefined, name: string): T[keyof T] | undefined => {
  if (!v) return undefined;
  if (!Object.values(e).includes(v)) throw new BadRequestException(`Invalid ${name}`);
  return v as T[keyof T];
};
const date = (v?: string) => (v ? new Date(v) : undefined);

class SittingDto {
  @IsOptional() @IsDateString() date?: string;
  @IsOptional() @IsString() @MaxLength(100) type?: string;
  @IsOptional() @IsIn(Object.values(SittingStatus)) status?: SittingStatus;
  @IsOptional() @IsArray() agenda?: unknown[];
}
class BillDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(300) title?: string;
  @IsOptional() @IsString() @MaxLength(200) sponsor?: string;
  @IsOptional() @IsIn(Object.values(BillStage)) stage?: BillStage;
  @IsOptional() @IsUUID() committeeId?: string;
  @IsOptional() @IsDateString() introducedOn?: string;
  @IsOptional() @IsString() @MaxLength(2000) summary?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) sittingIds?: string[];
}
class MemberDto {
  @IsUUID() mpId!: string;
  @IsOptional() @IsString() @MaxLength(50) role?: string;
}
class CommitteeDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) remit?: string;
  @IsOptional() @IsUUID() chairMpId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => MemberDto) members?: MemberDto[];
}
class ApprovalRequestDto {
  @IsIn([...GATED]) objectType!: GatedType;
  @IsUUID() objectId!: string;
  @IsIn(['publish', 'unpublish']) action!: 'publish' | 'unpublish';
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
class DecisionDto {
  @IsIn(['APPROVED', 'REJECTED', 'CHANGES_REQUESTED']) decision!: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  /** Required to approve an AI deployment: confirms the evaluation evidence was read. */
  @IsOptional() @IsBoolean() reviewedEvidence?: boolean;
}
const STAFF_ROLES = [Role.STAFF, Role.MP, Role.RESEARCHER, Role.REVIEWER, Role.ADMIN];
class InviteDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(2) @MaxLength(120) displayName!: string;
  @IsArray() @IsIn(STAFF_ROLES, { each: true }) roles!: Role[];
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) constituencyIds?: string[];
}
class UserDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) displayName?: string;
  @IsOptional() @IsArray() @IsIn(STAFF_ROLES, { each: true }) roles?: Role[];
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) constituencyIds?: string[];
}
class ActiveDto {
  @IsBoolean() active!: boolean;
}

/**
 * Parliamentary records for staff. Writes never change public visibility: that only happens
 * through an approval decided by a different REVIEWER/ADMIN (see /approvals).
 */
@Controller('internal')
export class OperationsController {
  constructor(private readonly ops: OperationsService) {}

  @Get('sittings') @Roles(...READ)
  sittings(@Query() q: Record<string, string>) { return this.ops.listSittings({ status: enumOf(SittingStatus, q.status, 'status'), from: date(q.from), to: date(q.to) }); }
  @Get('sittings/:id') @Roles(...READ)
  sitting(@Param('id') id: string) { return this.ops.getSitting(id); }
  @Post('sittings') @Roles(...WRITE) @Audit({ action: 'sitting.create', objectType: 'sitting' })
  createSitting(@Body() d: SittingDto) { return this.ops.saveSitting(null, { ...d, date: date(d.date) }); }
  @Patch('sittings/:id') @Roles(...WRITE) @Audit({ action: 'sitting.update', objectType: 'sitting' })
  updateSitting(@Param('id') id: string, @Body() d: SittingDto) { return this.ops.saveSitting(id, { ...d, date: date(d.date) }); }

  @Get('bills') @Roles(...READ)
  bills(@Query() q: Record<string, string>) { return this.ops.listBills({ stage: enumOf(BillStage, q.stage, 'stage'), search: q.search?.slice(0, 100) }); }
  @Get('bills/:id') @Roles(...READ)
  bill(@Param('id') id: string) { return this.ops.getBill(id); }
  @Post('bills') @Roles(...WRITE) @Audit({ action: 'bill.create', objectType: 'bill' })
  createBill(@Body() d: BillDto) { return this.ops.saveBill(null, { ...d, introducedOn: date(d.introducedOn) }); }
  @Patch('bills/:id') @Roles(...WRITE) @Audit({ action: 'bill.update', objectType: 'bill' })
  updateBill(@Param('id') id: string, @Body() d: BillDto) { return this.ops.saveBill(id, { ...d, introducedOn: date(d.introducedOn) }); }

  @Get('committees') @Roles(...READ)
  committees() { return this.ops.listCommittees(); }
  @Get('committees/:id') @Roles(...READ)
  committee(@Param('id') id: string) { return this.ops.getCommittee(id); }
  @Post('committees') @Roles(...WRITE) @Audit({ action: 'committee.create', objectType: 'committee' })
  createCommittee(@Body() d: CommitteeDto) { return this.ops.saveCommittee(null, d); }
  @Patch('committees/:id') @Roles(...WRITE) @Audit({ action: 'committee.update', objectType: 'committee' })
  updateCommittee(@Param('id') id: string, @Body() d: CommitteeDto) { return this.ops.saveCommittee(id, d); }

  @Get('approvals') @Roles(Role.STAFF, Role.REVIEWER, Role.ADMIN)
  approvals(@Query() q: Record<string, string>) {
    return this.ops.listApprovals({ decision: enumOf(ApprovalDecision, q.decision, 'decision'), objectType: q.objectType, objectId: q.objectId });
  }
  @Post('approvals') @HttpCode(201) @Roles(...WRITE) @Audit({ action: 'approval.request', objectType: 'approval', idParam: 'none' })
  requestApproval(@CurrentUser() p: Principal, @Body() d: ApprovalRequestDto) { return this.ops.requestApproval(p, d); }
  @Post('approvals/:id/decision') @HttpCode(200) @Roles(Role.REVIEWER, Role.ADMIN) @Audit({ action: 'approval.decide', objectType: 'approval' })
  decide(@CurrentUser() p: Principal, @Param('id') id: string, @Body() d: DecisionDto) { return this.ops.decide(p, id, d.decision, d.notes, d.reviewedEvidence); }

  @Get('users') @Roles(Role.ADMIN)
  users() { return this.ops.listUsers(); }
  @Post('users/invitations') @HttpCode(201) @Roles(Role.ADMIN) @Audit({ action: 'user.invite', objectType: 'user', idParam: 'none' })
  invite(@Body() d: InviteDto) { return this.ops.invite(d); }
  @Patch('users/:id') @Roles(Role.ADMIN) @Audit({ action: 'user.update', objectType: 'user' })
  updateUser(@CurrentUser() p: Principal, @Param('id') id: string, @Body() d: UserDto) { return this.ops.updateUser(p, id, d); }
  @Post('users/:id/active') @HttpCode(200) @Roles(Role.ADMIN) @Audit({ action: 'user.set_active', objectType: 'user' })
  setActive(@CurrentUser() p: Principal, @Param('id') id: string, @Body() d: ActiveDto) { return this.ops.setActive(p, id, d.active); }

  @Get('overview') @Roles(...READ)
  overview(@CurrentUser() p: Principal) { return this.ops.overview(p); }
}
