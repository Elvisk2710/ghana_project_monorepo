import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AnswersController } from './answers/answers.controller';
import { AnswersService } from './answers/answers.service';
import { AnswerGenerator, AnthropicGenerator, ExtractiveGenerator } from './answers/generator';
import { GovernanceController } from './governance/governance.controller';
import { GovernanceService } from './governance/governance.service';
import { IncidentsService } from './governance/incidents.service';
import { MonitoringService } from './governance/monitoring.service';
import { ReconstructionService } from './governance/reconstruction.service';
import { RuntimeConfigService } from './governance/runtime-config';
import { AlfrescoClient, RepositoryClient } from './alfresco/alfresco.client';
import { AuditController } from './audit/audit.controller';
import { AuditInterceptor } from './audit/audit.interceptor';
import { AuditService } from './audit/audit.service';
import { AuthGuard } from './auth/auth.guard';
import { AuthController } from './auth/auth.controller';
import { LocalAuthService } from './auth/local-auth';
import { APP_CONFIG, CompositeTokenVerifier, TokenVerifier } from './auth/token-verifier';
import { CasesService } from './cases/cases.service';
import { InternalCasesController } from './cases/internal-cases.controller';
import { NotificationSender, NotificationService } from './cases/notifications';
import { createSender } from './cases/senders';
import { StaffAlertService } from './cases/staff-alerts';
import { PublicCasesController } from './cases/public-cases.controller';
import { DefaultVirusScanner, VirusScanner } from './cases/scanner';
import { SettingsController } from './settings/settings.controller';
import { SettingsService } from './settings/settings.service';
import { OperationsController } from './operations/operations.controller';
import { OperationsService } from './operations/operations.service';
import { PublicOperationsController } from './operations/public-operations.controller';
import { requestContextModule } from './common/request-context';
import { InternalDirectoryController, PublicDirectoryController } from './directory/directory.controller';
import { DirectoryService } from './directory/directory.service';
import { loadConfig } from './config/env';
import { DocumentsController } from './documents/documents.controller';
import { DocumentsService } from './documents/documents.service';
import { DefaultTextExtractor, TextExtractor } from './documents/extractor';
import { Embedder, HashingEmbedder } from './documents/pipeline';
import { RepositoryController } from './documents/repository.controller';
import { HealthController } from './health/health.controller';
import { JobsController } from './jobs/jobs.controller';
import { JobsService } from './jobs/jobs.service';
import { MetricsController, MetricsService, ObservabilityInterceptor } from './metrics/metrics';
import { PrismaModule } from './prisma/prisma.service';
import { RolesGuard } from './rbac/rbac';
import { PublicController } from './search/public.controller';
import { SearchService } from './search/search.service';
import { MeController } from './users/me.controller';
import { AiTextService } from './insights/ai-text.service';
import { InsightsController } from './insights/insights.controller';
import { InsightsService } from './insights/insights.service';
import { SummariesController } from './insights/summaries.controller';
import { SummariesService } from './insights/summaries.service';
import { InternalMeetingDecisionController, InternalMeetingsController, PublicMeetingsController } from './meetings/meetings.controller';
import { MeetingsService } from './meetings/meetings.service';
import { InternalBillFeedbackController, PublicBillFeedbackController } from './feedback/bill-feedback.controller';
import { BillFeedbackService } from './feedback/bill-feedback.service';

const config = loadConfig();

@Module({
  imports: [
    requestContextModule,
    PrismaModule,
    ThrottlerModule.forRoot([{ ttl: config.throttleTtlMs, limit: config.throttleLimit }]),
  ],
  controllers: [
    HealthController,
    MetricsController,
    MeController,
    AuthController,
    AuditController,
    DocumentsController,
    RepositoryController,
    JobsController,
    PublicController,
    AnswersController,
    PublicDirectoryController,
    InternalDirectoryController,
    PublicCasesController,
    InternalCasesController,
    OperationsController,
    PublicOperationsController,
    GovernanceController,
    SettingsController,
    InsightsController,
    SummariesController,
    PublicMeetingsController,
    InternalMeetingsController,
    InternalMeetingDecisionController,
    PublicBillFeedbackController,
    InternalBillFeedbackController,
  ],
  providers: [
    { provide: APP_CONFIG, useValue: config },
    { provide: TokenVerifier, useClass: CompositeTokenVerifier },
    LocalAuthService,
    { provide: RepositoryClient, useClass: AlfrescoClient },
    { provide: TextExtractor, useClass: DefaultTextExtractor },
    // Development default. Bind a real embedding model here once the provider ADR is approved.
    { provide: Embedder, useFactory: () => new HashingEmbedder() },
    AuditService,
    MetricsService,
    JobsService,
    DocumentsService,
    SearchService,
    AnswersService,
    DirectoryService,
    OperationsService,
    RuntimeConfigService,
    GovernanceService,
    MonitoringService,
    IncidentsService,
    ReconstructionService,
    CasesService,
    NotificationService,
    { provide: VirusScanner, useClass: DefaultVirusScanner },
    // Delivery provider is a Phase 0 decision: log (development), webhook or smtp; unset fails deliveries visibly.
    { provide: NotificationSender, useFactory: () => createSender() },
    StaffAlertService,
    SettingsService,
    AiTextService,
    InsightsService,
    SummariesService,
    MeetingsService,
    BillFeedbackService,
    // The baseline generator is always extractive (no model, cannot invent facts). A model is used only
    // when an approved AI deployment selects it (see governance); there is no environment switch for it.
    ExtractiveGenerator,
    { provide: AnswerGenerator, useExisting: ExtractiveGenerator },
    { provide: AnthropicGenerator, useFactory: (extractive: ExtractiveGenerator) => new AnthropicGenerator(extractive), inject: [ExtractiveGenerator] },
    // Guard order: rate limit -> authenticate -> authorise (roles / constituency scope).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: ObservabilityInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
