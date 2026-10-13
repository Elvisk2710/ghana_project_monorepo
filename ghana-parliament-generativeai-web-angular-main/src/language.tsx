import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { api, LanguageInfo } from './api';

// Used if the language list cannot be loaded; only English is claimed as supported.
const FALLBACK: LanguageInfo[] = [{ code: 'en', name: 'English', level: 'supported', note: 'Questions and answers in English.' }];
const KEY = 'parliament.language';

interface Ctx {
  languages: LanguageInfo[];
  current: LanguageInfo;
  setCode: (code: string) => void;
}

const LanguageContext = createContext<Ctx>({ languages: FALLBACK, current: FALLBACK[0], setCode: () => undefined });
export const useLanguage = () => useContext(LanguageContext);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [languages, setLanguages] = useState<LanguageInfo[]>(FALLBACK);
  const [code, setCodeState] = useState(() => {
    try { return localStorage.getItem(KEY) ?? 'en'; } catch { return 'en'; }
  });

  useEffect(() => {
    let live = true;
    api.languages().then((l) => live && l.length && setLanguages(l)).catch(() => undefined);
    return () => { live = false; };
  }, []);

  const value = useMemo<Ctx>(() => ({
    languages,
    current: languages.find((l) => l.code === code) ?? languages[0],
    setCode: (c) => {
      setCodeState(c);
      try { localStorage.setItem(KEY, c); } catch { /* storage unavailable */ }
    },
  }), [languages, code]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}
