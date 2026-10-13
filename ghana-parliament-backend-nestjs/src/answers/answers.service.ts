import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AnswerStatus, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../audit/audit.service';
import type { RequestStore } from '../common/request-context';
import { RuntimeConfig, RuntimeConfigService } from '../governance/runtime-config';
import { PrismaService } from '../prisma/prisma.service';
import { SearchHit, SearchService } from '../search/search.service';
import { AnswerGenerator, AnthropicGenerator, ExtractiveGenerator, GeneratorOutput, Passage } from './generator';
import { findLanguage } from './languages';
import { looksLikeInjection, MAX_COMMENT_CHARS, MAX_QUESTION_CHARS, needsClarification, redactPii } from './safety';

export type StoredStatus =
  | 'grounded' | 'no_evidence' | 'needs_clarification' | 'conflicting_sources'
  | 'unsupported_language' | 'safety_refusal' | 'service_unavailable';
/** "answering_paused" is never stored: while the kill switch is on nothing is asked or saved. */
export type PublicStatus = StoredStatus | 'answering_paused';

export interface Citation {
  n: number;
  documentId: string;
  title: string;
  date: string | null;
  anchor: string | null;
  relevance: number;
}

export interface AnswerResponse {
  answerId: string;
  answer: string | null;
  /** User-safe explanation for any status other than "grounded". */
  message: string | null;
  language: string;
  status: PublicStatus;
  confidence: 'high' | 'medium' | 'low' | null;
  disclosure: string;
  citations: Citation[];
  answerVersion: { model: string | null; prompt: string | null; retriever: string | null };
  /** True when staff withdrew this answer after review; the text is no longer shown. */
  withdrawn?: boolean;
}

/** Exact passage text an answer relied on, kept so the answer can be reconstructed later. */
export interface SourceSnapshot {
  n: number;
  documentId: string; // public ID, e.g. HAN-1000
  documentUuid: string | null;
  documentVersion: number | null;
  documentChecksum: string | null;
  title: string;
  anchor: string | null;
  text: string;
  textSha256: string;
  score: number;
}

export const DISCLOSURE = 'AI-assisted result based only on published parliamentary records. It is not an official statement of Parliament. Check the cited sources.';

const MESSAGES: Record<Exclude<PublicStatus, 'grounded' | 'conflicting_sources'>, string> = {
  no_evidence: 'I could not find this in the published parliamentary records, so I will not guess. Try different words, a date range, or browse the Hansards directly.',
  needs_clarification: 'Please add a little more detail, for example the topic, the bill or the year you are interested in.',
  unsupported_language: 'This language is not available yet. Please ask in English. The official parliamentary record is published in English.',
  safety_refusal: 'I cannot help with that request. I can answer questions about what Parliament has said or done, using the published record.',
  service_unavailable: 'The service is temporarily unavailable. Please try again shortly. You can still browse the Hansards.',
  answering_paused: 'Ask Parliament is paused while we check a problem. You can still search and read the Hansards.',
};
const WITHDRAWN_MESSAGE = 'This answer was withdrawn after a review. Please ask the question again, and check the published sources directly.';

const STATUS_DB: Record<StoredStatus, AnswerStatus> = {
  grounded: 'GROUNDED', no_evidence: 'NO_EVIDENCE', needs_clarification: 'NEEDS_CLARIFICATION',
  conflicting_sources: 'CONFLICTING_SOURCES', unsupported_language: 'UNSUPPORTED_LANGUAGE',
  safety_refusal: 'SAFETY_REFUSAL', service_unavailable: 'SERVICE_UNAVAILABLE',
};
export const statusFromDb = (s: AnswerStatus): StoredStatus => Object.entries(STATUS_DB).find(([, v]) => v === s)![0] as StoredStatus;

export const REPORT_TYPES = ['incorrect', 'misleading', 'harmful', 'privacy', 'other'] as const;
const MAX_FEEDBACK_PER_ANSWER = 20;

interface Ctx { question: string; language: string; sessionRef?: string; started: number }

/** What the pipeline decided, before anything is stored or shown. */
export interface Outcome {
  status: StoredStatus;
  retrieved: SearchHit[];
  answer?: string;
  citations: Citation[];
  cited: Passage[];
  confidence?: 'high' | 'medium' | 'low';
  version: AnswerResponse['answerVersion'];
  piiRemoved: boolean;
  /** Why a degraded outcome happened (monitoring reads this). */
  failureReason?: string;
  topScore: number | null;
  usage?: GeneratorOutput['usage'];
}

const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');
const NO_VERSION = { model: null, prompt: null, retriever: null };

@Injectable()
export class AnswersService {
  private readonly logger = new Logger(AnswersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
    /** Baseline generator bound at start-up (extractive). Deployments choose between extractive and model. */
    private readonly generator: AnswerGenerator,
    private readonly extractive: ExtractiveGenerator,
    private readonly anthropic: AnthropicGenerator,
    private readonly audit: AuditService,
    private readonly cls: ClsService<RequestStore>,
    private readonly runtime: RuntimeConfigService,
  ) {}

  async ask(input: { question: string; language?: string; sessionRef?: string }): Promise<AnswerResponse> {
    const started = Date.now();
    const raw = (input.question ?? '').trim();
    if (!raw) throw new BadRequestException('question is required');
    if (raw.length > MAX_QUESTION_CHARS) throw new BadRequestException(`question must be at most ${MAX_QUESTION_CHARS} characters`);
    const language = input.language ?? 'en';
    if (!findLanguage(language)) throw new BadRequestException(`Unknown language code "${language}"`);

    // Only the redacted question is ever stored, logged or sent to a model.
    const { text: question, found } = redactPii(raw);
    const ctx: Ctx = { question, language, sessionRef: input.sessionRef, started };

    let live;
    try {
      live = await this.runtime.current();
    } catch (e) {
      this.logger.error(`Could not read AI configuration: ${(e as Error).message}`);
      return this.respond(ctx, this.blank('service_unavailable', found.length > 0, 'config_unavailable'), null);
    }
    if (!live.state.enabled) {
      return {
        answerId: 'unsaved', answer: null, message: MESSAGES.answering_paused, language, status: 'answering_paused',
        confidence: null, disclosure: DISCLOSURE, citations: [], answerVersion: NO_VERSION,
      };
    }
    const outcome = await this.run(ctx, raw, found.length > 0, live.config, true);
    return this.respond(ctx, outcome, live.config.deploymentId);
  }

  /**
   * Runs a question through the exact public pipeline with a candidate configuration, without
   * storing a session or writing audit events. Used by the evaluation harness.
   */
  async evaluate(input: { question: string; language: string }, config: RuntimeConfig): Promise<Outcome & { latencyMs: number }> {
    const started = Date.now();
    const { text, found } = redactPii(input.question.trim());
    const o = await this.run({ question: text, language: input.language, started }, input.question, found.length > 0, config, false);
    return { ...o, latencyMs: Date.now() - started };
  }

  private blank(status: StoredStatus, piiRemoved: boolean, failureReason?: string, retrieved: SearchHit[] = []): Outcome {
    const top = retrieved.length ? Math.max(...retrieved.map((h) => h.score)) : null;
    return { status, retrieved, citations: [], cited: [], version: NO_VERSION, piiRemoved, failureReason, topScore: top };
  }

  private generatorFor(config: RuntimeConfig): AnswerGenerator {
    return config.generator === 'anthropic' ? this.anthropic : config.generator === 'extractive' ? this.extractive : this.generator;
  }

  private async run(ctx: Ctx, raw: string, piiRemoved: boolean, config: RuntimeConfig, audit: boolean): Promise<Outcome> {
    const lang = findLanguage(ctx.language);
    if (!lang || lang.level !== 'supported') return this.blank('unsupported_language', piiRemoved);
    if (looksLikeInjection(raw)) {
      if (audit) await this.audit.recordSafe({ action: 'answer.refused', outcome: 'denied', payload: { reason: 'prompt_injection' } });
      return this.blank('safety_refusal', piiRemoved);
    }
    if (needsClarification(ctx.question)) return this.blank('needs_clarification', piiRemoved);

    let hits: SearchHit[];
    try {
      hits = await this.search.search({ q: ctx.question, limit: 8, language: ctx.language });
    } catch (e) {
      this.logger.error(`Retrieval failed: ${(e as Error).message}`);
      return this.blank('service_unavailable', piiRemoved, 'retrieval_error');
    }

    const usable: SearchHit[] = [];
    for (const h of hits) {
      if (h.score < config.retriever.minScore) continue;
      // Published text can still contain instruction-like content; never hand it to a model.
      if (looksLikeInjection(h.text)) {
        if (audit) await this.audit.recordSafe({ action: 'answer.passage_quarantined', outcome: 'denied', objectType: 'document', objectId: h.documentId, payload: { anchor: h.anchor } });
        continue;
      }
      usable.push(h);
    }
    if (!usable.length) return this.blank('no_evidence', piiRemoved, undefined, hits);

    const passages: Passage[] = usable.slice(0, config.retriever.maxPassages).map((h, i) => ({
      n: i + 1, documentId: h.documentId, title: h.title, date: h.date, anchor: h.anchor, text: h.text, score: h.score,
    }));

    let out: GeneratorOutput;
    try {
      out = await this.generatorFor(config).generate({ question: ctx.question, language: ctx.language, passages, settings: config.settings });
    } catch (e) {
      this.logger.error(`Generation failed: ${(e as Error).message}`);
      return this.blank('service_unavailable', piiRemoved, 'generation_error', hits);
    }
    const valid = new Set(passages.map((p) => p.n));
    if (!out.cited.length || out.cited.some((n) => !valid.has(n))) {
      this.logger.error('Generator returned missing or invalid citations');
      return this.blank('service_unavailable', piiRemoved, 'citation_invalid', hits);
    }

    const cited = passages.filter((p) => out.cited.includes(p.n));
    const citations: Citation[] = cited.map((p) => ({ n: p.n, documentId: p.documentId, title: p.title, date: p.date, anchor: p.anchor, relevance: p.score }));
    const top = Math.max(...citations.map((c) => c.relevance));
    const index = usable[0].indexVersion;
    return {
      status: out.conflicting ? 'conflicting_sources' : 'grounded',
      retrieved: hits,
      answer: out.answer,
      citations,
      cited,
      confidence: top >= 0.6 ? 'high' : top >= 0.35 ? 'medium' : 'low',
      version: { model: out.model, prompt: out.prompt, retriever: config.retriever.label ? `${config.retriever.label}/${index ?? 'index'}` : index },
      piiRemoved,
      // A model answer that failed validation was replaced by the extractive one: delivered, but counted.
      failureReason: out.fellBack ? 'fallback_extractive' : undefined,
      topScore: Math.max(...hits.map((h) => h.score)),
      usage: out.usage,
    };
  }

  private async snapshot(cited: Passage[]): Promise<SourceSnapshot[]> {
    const ids = [...new Set(cited.map((p) => p.documentId))];
    const docs = ids.length
      ? await this.prisma.parliamentaryDocument.findMany({ where: { publicId: { in: ids } }, select: { id: true, publicId: true, version: true, checksum: true } })
      : [];
    const byPublic = new Map(docs.map((d) => [d.publicId, d]));
    return cited.map((p) => {
      const d = byPublic.get(p.documentId);
      return {
        n: p.n, documentId: p.documentId, documentUuid: d?.id ?? null, documentVersion: d?.version ?? null, documentChecksum: d?.checksum ?? null,
        title: p.title, anchor: p.anchor, text: p.text, textSha256: sha256(p.text), score: p.score,
      };
    });
  }

  private async respond(ctx: Ctx, o: Outcome, deploymentId: string | null): Promise<AnswerResponse> {
    const status = o.status;
    const grounded = status === 'grounded' || status === 'conflicting_sources';
    const message = grounded ? (status === 'conflicting_sources' ? 'The published records disagree on this. Both positions are described below with their sources.' : null) : MESSAGES[status as keyof typeof MESSAGES];
    let answerId = 'unsaved';
    try {
      const sources = grounded ? await this.snapshot(o.cited) : undefined;
      const row = await this.prisma.questionSession.create({
        data: {
          sessionRef: ctx.sessionRef?.slice(0, 100),
          question: ctx.question,
          language: ctx.language,
          retrievalSet: o.retrieved.map((h) => ({ documentId: h.documentId, anchor: h.anchor, score: h.score })) as unknown as Prisma.InputJsonValue,
          answer: grounded ? o.answer : null,
          status: STATUS_DB[status],
          citations: o.citations as unknown as Prisma.InputJsonValue,
          modelVersion: o.version.model,
          promptVersion: o.version.prompt,
          retrieverVersion: o.version.retriever,
          correlationId: this.cls.get('correlationId'),
          latencyMs: Date.now() - ctx.started,
          deploymentId,
          failureReason: o.failureReason,
          topScore: o.topScore,
          sources: sources as unknown as Prisma.InputJsonValue | undefined,
        },
      });
      answerId = row.id;
    } catch (e) {
      // Never block an answer on logging, but make the gap visible.
      this.logger.error(`Could not persist question session: ${(e as Error).message}`);
    }
    await this.audit.recordSafe({
      action: 'answer.ask', objectType: 'answer', objectId: answerId,
      payload: { status, citations: o.citations.length, piiRemoved: o.piiRemoved, model: o.version.model, deploymentId, failureReason: o.failureReason ?? null, latencyMs: Date.now() - ctx.started },
    });
    return {
      answerId, answer: grounded ? o.answer ?? null : null, message, language: ctx.language, status,
      confidence: grounded ? o.confidence ?? null : null, disclosure: DISCLOSURE, citations: o.citations, answerVersion: o.version,
    };
  }

  /** Builds the public view of a stored answer (also used to show staff exactly what a user can see now). */
  view(r: { id: string; answer: string | null; language: string; status: AnswerStatus; citations: Prisma.JsonValue | null; modelVersion: string | null; promptVersion: string | null; retrieverVersion: string | null; withdrawnAt: Date | null }): AnswerResponse {
    const status = statusFromDb(r.status);
    const grounded = status === 'grounded' || status === 'conflicting_sources';
    const version = { model: r.modelVersion, prompt: r.promptVersion, retriever: r.retrieverVersion };
    if (r.withdrawnAt) {
      return { answerId: r.id, answer: null, message: WITHDRAWN_MESSAGE, language: r.language, status, confidence: null, disclosure: DISCLOSURE, citations: [], answerVersion: version, withdrawn: true };
    }
    return {
      answerId: r.id, answer: r.answer, message: grounded ? null : MESSAGES[status as keyof typeof MESSAGES], language: r.language, status,
      confidence: null, disclosure: DISCLOSURE, citations: (r.citations as unknown as Citation[]) ?? [], answerVersion: version,
    };
  }

  /** Re-opens a previous answer so it can be shared or revisited. */
  async get(id: string): Promise<AnswerResponse> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('Answer not found');
    const r = await this.prisma.questionSession.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Answer not found');
    return this.view(r);
  }

  async addFeedback(id: string, f: { helpful?: boolean; reportType?: (typeof REPORT_TYPES)[number]; comment?: string }): Promise<{ ok: true }> {
    if (f.helpful === undefined && !f.reportType && !f.comment) throw new BadRequestException('Provide helpful, reportType or comment');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('Answer not found');
    const session = await this.prisma.questionSession.findUnique({ where: { id }, select: { id: true, feedback: true } });
    if (!session) throw new NotFoundException('Answer not found');
    if (Array.isArray(session.feedback) && session.feedback.length >= MAX_FEEDBACK_PER_ANSWER) {
      throw new BadRequestException('Feedback limit reached for this answer');
    }
    const comment = f.comment ? redactPii(f.comment.slice(0, MAX_COMMENT_CHARS)).text : undefined;
    const entry = { at: new Date().toISOString(), helpful: f.helpful ?? null, reportType: f.reportType ?? null, comment: comment ?? null };
    // Atomic append so concurrent feedback is never lost.
    await this.prisma.$executeRaw`UPDATE "QuestionSession" SET "feedback" = COALESCE("feedback", '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb WHERE "id" = ${id}::uuid`;
    await this.audit.record({
      action: f.reportType ? 'answer.reported' : 'answer.feedback', objectType: 'answer', objectId: id,
      payload: { helpful: f.helpful ?? null, reportType: f.reportType ?? null, hasComment: !!comment },
    });
    return { ok: true };
  }
}
