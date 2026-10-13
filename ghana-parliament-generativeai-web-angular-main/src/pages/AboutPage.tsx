import { Link } from 'react-router-dom';
import { useLanguage } from '../language';

export default function AboutPage() {
  const { languages } = useLanguage();
  return (
    <div className="max-w-[760px] py-10">
      <h1 className="font-display text-[34px] font-semibold">About Parliament Connect</h1>
      <p className="mt-3 leading-7 text-ink-soft">Parliament Connect helps you find and understand what Parliament has published. The official record is always the authority.</p>

      <section aria-labelledby="can" className="mt-8">
        <h2 id="can" className="font-display text-[22px] font-semibold">What the AI can and cannot do</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6 leading-7">
          <li>It finds passages in <strong>published</strong> parliamentary records that match your question and shows them with their sources.</li>
          <li>It only uses records that Parliament staff have reviewed, approved and published. Drafts and withdrawn records are never used.</li>
          <li>If the records do not answer your question, it says so rather than guessing.</li>
          <li>It is <strong>not</strong> an official statement of Parliament. It does not give legal advice, state official positions, or confirm votes, bill status or commitments unless the cited record says so.</li>
          <li>It can be wrong. Always open the cited source, and use "Report a problem" if something looks incorrect or inappropriate.</li>
        </ul>
      </section>

      <section aria-labelledby="official" className="mt-8">
        <h2 id="official" className="font-display text-[22px] font-semibold">Official sources</h2>
        <p className="mt-3 leading-7">Each answer lists its sources. Open a source to see the exact passage or the full record. Records show their identifier and version so you can quote them precisely. Browse everything on the <Link to="/hansards" className="font-semibold text-parliament-green-deep underline">Hansards page</Link>.</p>
      </section>

      <section aria-labelledby="privacy" className="mt-8">
        <h2 id="privacy" className="font-display text-[22px] font-semibold">Privacy</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6 leading-7">
          <li>You do not need an account to ask a question.</li>
          <li>We store your question, the answer you received and any feedback you send, so Parliament can check quality and fix problems.</li>
          <li>Phone numbers, email addresses and Ghana Card numbers are removed from your question automatically before it is stored. Please do not type personal details anyway.</li>
          <li>How long this information is kept has not been finalised and will be published here once Parliament confirms it.</li>
        </ul>
      </section>

      <section aria-labelledby="lang" className="mt-8">
        <h2 id="lang" className="font-display text-[22px] font-semibold">Languages</h2>
        <p className="mt-3 leading-7">We only list a language as available when it has been properly tested. Today you can ask questions in English; other languages are planned.</p>
        <table className="mt-3 w-full border-collapse text-left text-sm">
          <caption className="sr-only">Language support</caption>
          <thead><tr><th scope="col" className="border-b border-parliament-line py-2 pr-4">Language</th><th scope="col" className="border-b border-parliament-line py-2 pr-4">Status</th></tr></thead>
          <tbody>
            {languages.map((l) => (
              <tr key={l.code}><th scope="row" className="border-b border-parliament-line py-2 pr-4 font-medium">{l.name}</th><td className="border-b border-parliament-line py-2">{l.level === 'supported' ? 'Available' : 'Not yet available'}</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="access" className="mt-8">
        <h2 id="access" className="font-display text-[22px] font-semibold">Accessibility and help</h2>
        <p className="mt-3 leading-7">This site is designed to work with a keyboard and screen readers and on small screens. If something is hard to use, please tell us using "Report a problem" on any answer.</p>
      </section>
    </div>
  );
}
