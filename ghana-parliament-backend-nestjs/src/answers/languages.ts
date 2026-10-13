// Honest per-language support levels (T-044 / "language honesty").
// Only languages with evaluation evidence may be marked "supported". Others are listed so the
// public app can say clearly what works today instead of implying translation exists.

export type SupportLevel = 'supported' | 'planned';

export interface LanguageInfo {
  code: string;
  name: string;
  level: SupportLevel;
  note: string;
}

export const LANGUAGES: LanguageInfo[] = [
  { code: 'en', name: 'English', level: 'supported', note: 'Questions and answers in English.' },
  { code: 'tw', name: 'Akan (Twi)', level: 'planned', note: 'Not yet available. Please ask in English; the official record is in English.' },
  { code: 'ee', name: 'Ewe', level: 'planned', note: 'Not yet available. Please ask in English; the official record is in English.' },
  { code: 'gaa', name: 'Ga', level: 'planned', note: 'Not yet available. Please ask in English; the official record is in English.' },
  { code: 'dag', name: 'Dagbani', level: 'planned', note: 'Not yet available. Please ask in English; the official record is in English.' },
  { code: 'ha', name: 'Hausa', level: 'planned', note: 'Not yet available. Please ask in English; the official record is in English.' },
];

export const findLanguage = (code: string) => LANGUAGES.find((l) => l.code === code);
