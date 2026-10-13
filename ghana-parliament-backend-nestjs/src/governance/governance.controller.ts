import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { AiArtifactKind, IncidentSeverity, Role } from '@prisma/client';
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CurrentUser } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { Roles } from '../rbac/rbac';
import { GovernanceService } from './governance.service';
import { IncidentsService } from './incidents.service';
import { MonitoringService } from './monitoring.service';
import { ReconstructionService } from './reconstruction.service';

const READ = [Role.RESEARCHER, Role.REVIEWER, Role.ADMIN] as const;
const BUILD = [Role.RESEARCHER, Role.ADMIN] as const;
const OPERATE = [Role.REVIEWER, Role.ADMIN] as const;

class VersionDto {
  @IsIn(['MODEL', 'PROMPT', 'RETRIEVER']) kind!: 'MODEL' | 'PROMPT' | 'RETRIEVER';
  @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @IsString() @MinLength(1) @MaxLength(40) version!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsObject() config!: Record<string, unknown>;
  @IsOptional() @IsUUID() ownerId?: string;
}
class DatasetDto {
  @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @IsString() @MinLength(1) @MaxLength(40) version!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsArray() cases!: unknown[];
  @IsOptional() @IsUUID() ownerId?: string;
}
class RetireDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}
class RunDto {
  @IsUUID() datasetId!: string;
  @IsUUID() modelId!: string;
  @IsUUID() promptId!: string;
  @IsUUID() retrieverId!: string;
  @IsOptional() @IsObject() thresholds?: Record<string, number>;
}
class DeploymentDto {
  @IsUUID() modelId!: string;
  @IsUUID() promptId!: string;
  @IsUUID() retrieverId!: string;
  @IsUUID() evalRunId!: string;
  @IsOptional() @IsUUID() ownerId?: string;
  @IsOptional() @IsObject() thresholds?: Record<string, number>;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}
class ReasonDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @IsOptional() @IsUUID() incidentId?: string;
}
class IncidentDto {
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsString() @MinLength(3) @MaxLength(4000) description!: string;
  @IsIn(Object.values(IncidentSeverity)) severity!: IncidentSeverity;
  @IsOptional() @IsObject() scope?: Record<string, unknown>;
  @IsOptional() @IsUUID() alertId?: string;
  @IsOptional() @IsUUID() ownerId?: string;
  @IsOptional() @IsBoolean() pauseAnswering?: boolean;
}
class IncidentStatusDto {
  @IsIn(['MITIGATED', 'RESOLVED']) status!: 'MITIGATED' | 'RESOLVED';
  @IsString() @MinLength(3) @MaxLength(2000) note!: string;
}
class NoteDto {
  @IsString() @MinLength(3) @MaxLength(500) note!: string;
}
class SampleDto {
  @IsOptional() @IsInt() @Min(1) @Max(200) sample?: number;
  @IsOptional() @IsString() since?: string;
}
class EvaluateDto {
  @IsOptional() @IsInt() @Min(5) @Max(1440) windowMinutes?: number;
}

/**
 * AI governance for researchers, reviewers and administrators: registry, evaluation, deployment
 * approval and rollback, monitoring, incidents and the public-answering kill switch.
 * Every state change is written to the audit ledger by the service that performs it.
 */
@Controller('internal/ai')
export class GovernanceController {
  constructor(
    private readonly gov: GovernanceService,
    private readonly monitoring: MonitoringService,
    private readonly incidents: IncidentsService,
    private readonly reconstruction: ReconstructionService,
  ) {}

  // ---- Registry
  @Get('versions') @Roles(...READ)
  versions(@Query('kind') kind?: string, @Query('includeRetired') inc?: string) {
    if (kind && !(Object.values(AiArtifactKind) as string[]).includes(kind)) throw new BadRequestException('Invalid kind');
    return this.gov.listVersions({ kind: kind as AiArtifactKind | undefined, includeRetired: inc === 'true' });
  }
  @Post('versions') @HttpCode(201) @Roles(...BUILD)
  register(@CurrentUser() p: Principal, @Body() d: VersionDto) { return this.gov.registerVersion(p, d); }
  @Post('versions/:id/retire') @HttpCode(200) @Roles(...BUILD)
  retire(@CurrentUser() p: Principal, @Param('id') id: string, @Body() d: RetireDto) { return this.gov.retireVersion(p, id, d.reason); }
  @Post('registry/baseline') @HttpCode(200) @Roles(Role.ADMIN)
  baseline(@CurrentUser() p: Principal) { return this.gov.registerBaseline(p); }
  @Post('datasets') @HttpCode(201) @Roles(...BUILD)
  dataset(@CurrentUser() p: Principal, @Body() d: DatasetDto) { return this.gov.registerDataset(p, d); }
  @Get('datasets/:id') @Roles(...READ)
  getDataset(@Param('id') id: string) { return this.gov.getDataset(id); }

  // ---- Evaluation
  @Post('evaluations') @HttpCode(201) @Roles(...BUILD)
  createRun(@CurrentUser() p: Principal, @Body() d: RunDto) { return this.gov.createRun(p, d); }
  @Get('evaluations') @Roles(...READ)
  runs() { return this.gov.listRuns(); }
  @Get('evaluations/:id') @Roles(...READ)
  run(@Param('id') id: string) { return this.gov.getRun(id); }
  @Get('evaluations/:id/results') @Roles(...READ)
  results(@Param('id') id: string, @Query('failed') failed?: string, @Query('language') language?: string, @Query('limit') limit?: string) {
    return this.gov.runResults(id, { failedOnly: failed === 'true', language, limit: limit ? parseInt(limit, 10) || undefined : undefined });
  }

  // ---- Deployment
  @Get('deployments') @Roles(...READ)
  deployments() { return this.gov.listDeployments(); }
  @Get('deployments/active') @Roles(...READ)
  active() { return this.gov.active(); }
  @Get('deployments/:id') @Roles(...READ)
  deployment(@Param('id') id: string) { return this.gov.getDeployment(id); }
  @Post('deployments') @HttpCode(201) @Roles(...BUILD)
  requestDeployment(@CurrentUser() p: Principal, @Body() d: DeploymentDto) { return this.gov.requestDeployment(p, d); }
  @Post('deployments/:id/rollback') @HttpCode(200) @Roles(...OPERATE)
  rollback(@CurrentUser() p: Principal, @Param('id') id: string, @Body() d: ReasonDto) { return this.gov.rollback(p, id, d.reason); }

  // ---- Kill switch
  @Get('answering') @Roles(...READ)
  answering() { return this.gov.answeringState(); }
  @Post('answering/pause') @HttpCode(200) @Roles(...OPERATE)
  pause(@CurrentUser() p: Principal, @Body() d: ReasonDto) { return this.gov.pause(p, d.reason, d.incidentId); }
  @Post('answering/resume') @HttpCode(200) @Roles(...OPERATE)
  resume(@CurrentUser() p: Principal, @Body() d: ReasonDto) { return this.gov.resume(p, d.reason, d.incidentId); }

  // ---- Monitoring
  @Get('monitoring') @Roles(...READ)
  async report(@Query('windowMinutes') w?: string) {
    const report = await this.monitoring.report(w ? parseInt(w, 10) || undefined : undefined);
    return { ...report, alerts: await this.monitoring.listAlerts() };
  }
  @Post('monitoring/evaluate') @HttpCode(200) @Roles(...READ)
  evaluate(@Body() d: EvaluateDto) { return this.monitoring.evaluate(d.windowMinutes); }
  @Get('alerts') @Roles(...READ)
  alerts(@Query('status') status?: string) { return this.monitoring.listAlerts(status); }
  @Post('alerts/:id/acknowledge') @HttpCode(200) @Roles(...READ)
  acknowledge(@CurrentUser() p: Principal, @Param('id') id: string) { return this.monitoring.acknowledge(p, id); }

  // ---- Incidents
  @Get('incidents') @Roles(...READ)
  listIncidents(@Query('status') status?: string) { return this.incidents.list(status); }
  @Post('incidents') @HttpCode(201) @Roles(...READ)
  openIncident(@CurrentUser() p: Principal, @Body() d: IncidentDto) { return this.incidents.create(p, d); }
  @Get('incidents/:id') @Roles(...READ)
  incident(@Param('id') id: string) { return this.incidents.get(id); }
  @Get('incidents/:id/affected') @Roles(...READ)
  affected(@Param('id') id: string, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.incidents.affected(id, { limit: limit ? parseInt(limit, 10) || undefined : undefined, cursor });
  }
  @Post('incidents/:id/status') @HttpCode(200) @Roles(...OPERATE)
  incidentStatus(@CurrentUser() p: Principal, @Param('id') id: string, @Body() d: IncidentStatusDto) { return this.incidents.setStatus(p, id, d.status, d.note); }
  @Post('incidents/:id/withdraw-answers') @HttpCode(200) @Roles(...OPERATE)
  withdraw(@CurrentUser() p: Principal, @Param('id') id: string, @Body() d: NoteDto) { return this.incidents.withdrawAnswers(p, id, d.note); }

  // ---- Audit reconstruction
  @Get('answers/:id/reconstruction') @Roles(...READ)
  reconstruct(@Param('id') id: string) { return this.reconstruction.reconstruct(id, { record: true }); }
  @Post('reconstruction-test') @HttpCode(200) @Roles(...READ)
  reconstructionTest(@Body() d: SampleDto) {
    if (d.since && Number.isNaN(Date.parse(d.since))) throw new BadRequestException('since must be a date-time');
    return this.reconstruction.verifySample(d.sample ?? 25, d.since ? new Date(d.since) : undefined);
  }
}
