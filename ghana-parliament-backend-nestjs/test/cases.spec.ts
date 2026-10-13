import { CasePriority, CaseStatus } from '@prisma/client';
import { matchConstituencies, norm } from '../src/directory/directory.service';
import { renderNotification } from '../src/cases/notifications';
import { CATEGORY_IDS, TRANSITIONS, canTransition, evaluateEscalation, statusAfterCitizenReply, suggest } from '../src/cases/rules';
import { MAX_ATTACHMENT_BYTES, basicScan, sanitizeFilename } from '../src/cases/scanner';

describe('case status machine', () => {
  const all = Object.values(CaseStatus);

  it('allows the documented transitions only', () => {
    expect(canTransition('RECEIVED', 'TRIAGED')).toBe(true);
    expect(canTransition('TRIAGED', 'IN_PROGRESS')).toBe(true);
    expect(canTransition('IN_PROGRESS', 'AWAITING_INFORMATION')).toBe(true);
    expect(canTransition('AWAITING_INFORMATION', 'IN_PROGRESS')).toBe(true);
    expect(canTransition('RESOLVED', 'IN_PROGRESS')).toBe(true); // reopen
    expect(canTransition('RECEIVED', 'RESOLVED')).toBe(false); // must be triaged first
    expect(canTransition('RECEIVED', 'IN_PROGRESS')).toBe(false);
  });

  it('treats CLOSED as terminal and never loops to itself', () => {
    expect(TRANSITIONS.CLOSED).toEqual([]);
    all.forEach((s) => expect(canTransition(s, s)).toBe(false));
  });

  it('can always reach CLOSED from every open status', () => {
    all.filter((s) => s !== 'CLOSED').forEach((s) => expect(canTransition(s, 'CLOSED')).toBe(true));
  });

  it('moves a case back to work on a citizen reply, but never reopens a closed one', () => {
    expect(statusAfterCitizenReply('AWAITING_INFORMATION')).toBe('IN_PROGRESS');
    expect(statusAfterCitizenReply('RESOLVED')).toBe('IN_PROGRESS');
    expect(statusAfterCitizenReply('IN_PROGRESS')).toBeNull();
    expect(statusAfterCitizenReply('CLOSED')).toBeNull();
  });
});

describe('category suggestion', () => {
  it('suggests a category and a summary without altering the text', () => {
    const text = 'The road to our market is full of potholes. Cars cannot pass in the rain.';
    const s = suggest(text);
    expect(s.category).toBe('roads_infrastructure');
    expect(s.confidence).toBeGreaterThan(0);
    expect(s.summary).toBe('The road to our market is full of potholes.');
    expect(s.method).toMatch(/rules/);
  });

  it('falls back to "other" with zero confidence rather than guessing', () => {
    expect(suggest('Hello there, I have something to say about nothing in particular.')).toMatchObject({ category: 'other', confidence: 0 });
  });

  it('only ever suggests known categories', () => {
    for (const t of ['hospital nurse', 'bribe corruption', 'farmers cocoa fertilizer', 'court lawyer']) expect(CATEGORY_IDS).toContain(suggest(t).category);
  });
});

describe('escalation rules', () => {
  it('escalates threats to personal safety as URGENT', () => {
    const d = evaluateEscalation({ category: 'other', text: 'A man has threatened to kill my family' });
    expect(d).toMatchObject({ escalate: true, priority: CasePriority.URGENT });
    expect(d.ruleIds).toContain('personal_safety');
  });

  it('escalates sensitive categories to HIGH', () => {
    const d = evaluateEscalation({ category: 'corruption_allegation', text: 'Contract was awarded irregularly' });
    expect(d).toMatchObject({ escalate: true, priority: CasePriority.HIGH });
  });

  it('escalates allegations against named officials', () => {
    expect(evaluateEscalation({ category: 'other', text: 'The district director demanded a bribe from me' }).ruleIds).toContain('named_official_allegation');
  });

  it('leaves ordinary issues alone', () => {
    expect(evaluateEscalation({ category: 'roads_infrastructure', text: 'The street light on my road is broken' })).toMatchObject({ escalate: false, priority: CasePriority.NORMAL, ruleIds: [] });
  });

  it('matches whole words only, so words that merely contain a trigger do not fire', () => {
    expect(evaluateEscalation({ category: 'education', text: 'Work has begun on the classroom block and the gunnery of the old fort is a tourist site' }).escalate).toBe(false);
  });

  it('errs towards escalating: ambiguous safety words still reach a human', () => {
    // Deliberate trade-off: a false escalation costs a human a minute; a missed threat costs far more.
    expect(evaluateEscalation({ category: 'roads_infrastructure', text: 'The beaten path to the school is flooded' }).escalate).toBe(true);
  });
});

describe('attachment scanning', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');
  const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

  it('accepts plain PDF and PNG evidence', () => {
    expect(basicScan(png, 'photo.png', 'image/png')).toMatchObject({ clean: true, detectedType: 'image/png' });
    expect(basicScan(pdf, 'letter.pdf', 'application/pdf').clean).toBe(true);
  });

  it('rejects the EICAR test signature', () => {
    const r = basicScan(Buffer.from(`%PDF-1.4\n${EICAR}`), 'x.pdf', 'application/pdf');
    expect(r.clean).toBe(false);
    expect(r.detail).toMatch(/EICAR/);
  });

  it('rejects executables and scripts however they are named', () => {
    expect(basicScan(Buffer.from('MZ\x90\x00 fake exe'), 'photo.png', 'image/png').clean).toBe(false);
    expect(basicScan(Buffer.from('#!/bin/sh\nrm -rf /'), 'run.pdf', 'application/pdf').clean).toBe(false);
    expect(basicScan(Buffer.from('<script>alert(1)</script>'), 'a.png', 'image/png').clean).toBe(false);
  });

  it('rejects a declared type or extension that does not match the bytes', () => {
    expect(basicScan(png, 'photo.png', 'application/pdf').detail).toMatch(/does not match/);
    expect(basicScan(png, 'photo.pdf', 'image/png').detail).toMatch(/extension/);
  });

  it('rejects PDFs with active content', () => {
    const js = Buffer.from('%PDF-1.4\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj');
    expect(basicScan(js, 'a.pdf', 'application/pdf').detail).toMatch(/active/);
  });

  it('rejects empty and oversized files', () => {
    expect(basicScan(Buffer.alloc(0), 'a.png', 'image/png').clean).toBe(false);
    expect(basicScan(Buffer.concat([png, Buffer.alloc(MAX_ATTACHMENT_BYTES)]), 'a.png', 'image/png').detail).toMatch(/too large/);
  });

  it('sanitises filenames', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\x\\evil".png')).toBe('evil.png');
    expect(sanitizeFilename('..hidden\u0000.pdf')).toBe('hidden.pdf');
    expect(sanitizeFilename('')).toBe('attachment');
  });
});

describe('constituency matching', () => {
  const list = [
    { id: '1', code: 'C-TE', name: 'Tema East', region: 'Greater Accra', aliases: ['Tema Community 1'] },
    { id: '2', code: 'C-TW', name: 'Tema West', region: 'Greater Accra', aliases: [] },
    { id: '3', code: 'C-TC', name: 'Tamale Central', region: 'Northern', aliases: ['Tamale'] },
    { id: '4', code: 'C-AK', name: 'Ablekuma North', region: 'Greater Accra', aliases: [] },
  ];

  it('normalises case, accents and punctuation', () => {
    expect(norm('  Tèma-East! ')).toBe('tema east');
  });

  it('ranks exact name first and says how it matched', () => {
    const m = matchConstituencies('tema east', list);
    expect(m[0]).toMatchObject({ kind: 'exact_name', c: { id: '1' } });
  });

  it('matches official codes and recorded aliases', () => {
    expect(matchConstituencies('c-tc', list)[0]).toMatchObject({ kind: 'code', c: { id: '3' } });
    expect(matchConstituencies('Tamale', list)[0]).toMatchObject({ kind: 'alias', via: 'Tamale', c: { id: '3' } });
  });

  it('returns every plausible partial match and labels them as partial', () => {
    const m = matchConstituencies('Tema', list);
    expect(m.map((x) => x.c.id).sort()).toEqual(['1', '2']);
    expect(m.every((x) => x.kind === 'starts_with')).toBe(true);
  });

  it('never guesses: unknown or too-short queries return nothing', () => {
    expect(matchConstituencies('Atlantis', list)).toEqual([]);
    expect(matchConstituencies('a', list)).toEqual([]);
    expect(matchConstituencies('', list)).toEqual([]);
  });
});

describe('notification text', () => {
  it('contains the reference and status but never case content or internal data', () => {
    const n = renderNotification('status_update', 'GH-2026-000001', 'IN_PROGRESS', 'https://app.example/');
    expect(n.body).toContain('GH-2026-000001');
    expect(n.body).toContain('In progress');
    expect(n.body).toContain('https://app.example/issues');
    expect(n.body).not.toMatch(/\/\/\/|undefined/);
  });

  it('asks for information when the office needs it', () => {
    expect(renderNotification('follow_up_request', 'GH-2026-000002', 'AWAITING_INFORMATION', 'https://app.example').subject).toMatch(/more information/);
  });
});
