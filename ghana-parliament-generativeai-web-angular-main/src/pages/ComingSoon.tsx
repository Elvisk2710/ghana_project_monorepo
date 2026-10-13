import { Link } from 'react-router-dom';

/** Honest placeholder for features that are planned but not built. */
export default function ComingSoon({ title, body }: { title: string; body: string }) {
  return (
    <div className="max-w-[640px] py-12">
      <h1 className="font-display text-[34px] font-semibold">{title}</h1>
      <p role="status" className="mt-4 inline-block rounded-full bg-gold-wash px-4 py-1.5 text-sm font-bold text-ink">Not available yet</p>
      <p className="mt-4 leading-7 text-ink-soft">{body}</p>
      <p className="mt-6"><Link to="/" className="font-semibold text-parliament-green-deep underline">Ask Parliament a question</Link> or <Link to="/hansards" className="font-semibold text-parliament-green-deep underline">browse the Hansards</Link>.</p>
    </div>
  );
}
