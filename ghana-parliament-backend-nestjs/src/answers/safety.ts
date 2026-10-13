// Input/output safety helpers for the public Ask Parliament flow (T-036).

const PII_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'email', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { label: 'ghana_card', re: /\bGHA-\d{9}-\d\b/gi },
  { label: 'phone', re: /(?:\+233|\b0)[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/g },
];

export interface RedactionResult {
  text: string;
  found: string[];
}

/** Replaces personal identifiers with placeholders so they never reach prompts, logs or storage. */
export function redactPii(input: string): RedactionResult {
  let text = input;
  const found: string[] = [];
  for (const { label, re } of PII_PATTERNS) {
    text = text.replace(re, () => {
      found.push(label);
      return `[${label} removed]`;
    });
  }
  return { text, found };
}

// Attempts to override the assistant's instructions or extract its configuration.
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|messages?)/i,
  /disregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|your)\s+(?:instructions?|prompts?|rules?)/i,
  /(?:reveal|show|print|repeat|output)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+)?(?:prompt|instructions?|configuration|api\s*key)/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+instructions?\s*:/i,
  /\b(?:jailbreak|developer\s+mode|DAN\s+mode)\b/i,
  /<\/?\s*(?:system|assistant|instructions?)\s*>/i,
  /\bact\s+as\s+(?:if\s+you\s+(?:are|were)|an?\s+(?:unrestricted|unfiltered))/i,
];

export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

export const MAX_QUESTION_CHARS = 500;
export const MAX_COMMENT_CHARS = 1000;

/** Questions with too little content to retrieve against ask the user to say more. */
export function needsClarification(question: string): boolean {
  const words = question.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length < 2 || question.replace(/[^\p{L}\p{N}]/gu, '').length < 4;
}
