import { Injectable, Logger } from '@nestjs/common';

/**
 * Shared "honest AI" gateway for the text-generation features that need a live model call
 * (sentiment analysis, per-sitting summarization, AI-drafted case responses): per-sitting
 * summarization, constituency sentiment, and AI-drafted case responses.
 *
 * It never fabricates output. When no provider is configured it reports that plainly, the same
 * pattern already used for unsupported languages (see `answers/languages.ts`) — a feature that
 * cannot do its job yet says so instead of guessing.
 */
export interface AiTextResult {
  available: true;
  text: string;
  model: string;
}
export interface AiTextUnavailable {
  available: false;
  reason: string;
}

@Injectable()
export class AiTextService {
  private readonly logger = new Logger(AiTextService.name);

  isConfigured(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }

  async complete(system: string, user: string): Promise<AiTextResult | AiTextUnavailable> {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      return { available: false, reason: 'No AI provider is configured yet. An administrator must set ANTHROPIC_API_KEY and an approved AI deployment before this feature can run.' };
    }
    const model = process.env.ANSWER_MODEL ?? 'claude-sonnet-5-5';
    const base = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
    try {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 800, temperature: 0, system, messages: [{ role: 'user', content: user }] }),
        signal: AbortSignal.timeout(Number(process.env.ANSWER_TIMEOUT_MS ?? 20000)),
      });
      if (!res.ok) return { available: false, reason: `The AI provider returned an error (${res.status}). Try again shortly.` };
      const data: any = await res.json();
      const text = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      if (!text.trim()) return { available: false, reason: 'The AI provider returned an empty response.' };
      return { available: true, text, model };
    } catch (e: any) {
      this.logger.warn(`AI text call failed: ${e?.message}`);
      return { available: false, reason: 'The AI service is temporarily unavailable. Try again shortly.' };
    }
  }
}
