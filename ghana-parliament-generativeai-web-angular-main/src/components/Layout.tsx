import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useEffect, useRef } from 'react';
import { useLanguage } from '../language';

const nav = [
  { to: '/', label: 'Ask Parliament', end: true },
  { to: '/hansards', label: 'Hansards' },
  { to: '/bills', label: 'Bills' },
  { to: '/my-mp', label: 'My MP' },
  { to: '/issues', label: 'Issues' },
  { to: '/about', label: 'About' },
];

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-2 py-1 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parliament-green ${isActive ? 'text-parliament-green-deep underline' : 'text-ink-soft'}`;

export default function Layout() {
  const { languages, current, setCode } = useLanguage();
  const { pathname } = useLocation();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Move focus to the page content after navigation so keyboard and screen-reader users land in the right place.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    main.current?.focus();
    window.scrollTo?.(0, 0);
  }, [pathname]);

  return (
    <div className="mx-auto max-w-[1180px] px-5 sm:px-7">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-paper focus:px-4 focus:py-2 focus:shadow-portal">Skip to main content</a>
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-parliament-line py-[18px]">
        <NavLink to="/" className="flex items-center gap-3.5 text-ink no-underline" aria-label="Parliament Connect home">
          <span className="crest" aria-hidden="true" />
          <span>
            <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-parliament-green-deep">Republic of Ghana</span>
            <strong className="font-display text-[19px]">Parliament Connect</strong>
          </span>
        </NavLink>
        <nav aria-label="Main" className="order-3 flex w-full flex-wrap items-center gap-x-4 gap-y-1 md:order-none md:w-auto md:gap-x-6">
          {nav.map((n) => <NavLink key={n.to} to={n.to} end={n.end} className={linkClass}>{n.label}</NavLink>)}
        </nav>
        <div className="flex items-center gap-2">
          <label htmlFor="lang" className="text-xs font-semibold text-ink-soft">Language</label>
          <select
            id="lang"
            value={current.code}
            onChange={(e) => setCode(e.target.value)}
            className="rounded-full border border-parliament-line bg-paper px-3 py-1.5 text-xs font-semibold text-ink"
          >
            {languages.map((l) => <option key={l.code} value={l.code}>{l.name}{l.level === 'planned' ? ' (not yet available)' : ''}</option>)}
          </select>
        </div>
      </header>
      {current.level !== 'supported' && (
        <p role="status" className="mt-4 rounded-xl bg-gold-wash px-4 py-3 text-sm text-ink">
          <strong>{current.name} is not available yet.</strong> {current.note}
        </p>
      )}
      <main id="main" ref={main} tabIndex={-1} className="outline-none">
        <Outlet />
      </main>
      <footer className="mt-[90px] border-t border-parliament-line py-8 text-[13px] text-ink-soft">
        <p>&copy; 2026 Parliament of Ghana. AI-assisted results come only from published parliamentary records and are not official statements.</p>
        <p className="mt-1"><NavLink to="/about" className="underline">How this works, privacy and limits</NavLink></p>
      </footer>
    </div>
  );
}
