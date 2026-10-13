import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { MlOpsScreen } from './AiScreens';
import { ApprovalsScreen } from './GovernanceScreens';

type Reply = { status: number; body: unknown } | undefined;
let calls: { url: string; method: string; body?: any }[];
let respond: (path: string, method: string) => Reply;
let roles: string[];

const iso = (d = 0) => new Date(Date.now() + d * 86_400_000).toISOString();
const ref = (name: string, version = 'v1') => ({ id: `${name}-id`, name, version });
const metrics = (o = {}) => ({ n: 9, answerQuality: 0.89, retrievalRecall: 1, retrievalCases: 5, citationCompleteness: 1, groundedAnswers: 5, refusalQuality: 1, refusalCases: 4, harmfulOutputs: 0, latencyP50Ms: 40, latencyP95Ms: 90, inputTokens: 0, outputTokens: 0, ...o });
const run = (o = {}) => ({
  id: 'r1', status: 'COMPLETED', total: 9, completed: 9, createdAt: iso(-1), completedAt: iso(-1), error: null,
  dataset: ref('gold'), model: ref('extractive'), prompt: ref('grounded'), retriever: ref('hybrid'), summary: metrics(),
  slices: [
    { dimension: 'language', value: 'en', ...metrics({ n: 8 }), underpowered: false },
    { dimension: 'language', value: 'tw', ...metrics({ n: 1, answerQuality: 1 }), underpowered: true },
  ],
  gate: { passed: true, failures: [], warnings: ['Slice language "tw" has only 1 case(s): too few to be reliable'], thresholds: { minAnswerQuality: 0.8 } }, ...o,
});
const dep = (o = {}) => ({
  id: 'd1', status: 'ACTIVE', model: ref('extractive'), prompt: ref('grounded'), retriever: ref('hybrid'), ownerId: 'u-res', ownerName: 'Esi Owner', requesterId: 'u-res', approvalId: 'a1',
  rollbackTargetId: null, notes: null, activatedAt: iso(-1), endedAt: null, endedReason: null, createdAt: iso(-2), approval: { decision: 'APPROVED', approver: { displayName: 'Kojo Reviewer' }, requester: { displayName: 'Esi Owner' }, decidedAt: iso(-1) }, ...o,
});
const rule = (o = {}) => ({ rule: 'citation_failure_rate', scopeKey: '', severity: 'HIGH', metric: 'm', status: 'ok', value: 0, threshold: 0.02, sampleSize: 40, message: 'Answers with missing or invalid citations is 0% (alert at 2%)', ...o });

let db: Record<string, any>;
beforeEach(() => {
  calls = [];
  roles = ['RESEARCHER'];
  respond = () => undefined;
  db = {
    answering: { enabled: true, reason: null, changedAt: null, incidentId: null }, active: {}, versions: [], runs: [], deployments: [],
    monitoring: { at: iso(), windowMinutes: 60, deploymentId: null, rules: [], alerts: [] }, incidents: [],
  };
  sessionStorage.setItem('parliament.access_token', 'tok');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace('/api/v1/internal', '');
    const method = init.method ?? 'GET';
    calls.push({ url: path, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    const custom = respond(path, method);
    const out: NonNullable<Reply> = custom ?? (
      path === '/me' ? { status: 200, body: { userId: 'u-me', email: 'me@x', roles, constituencyIds: [] } }
      : path === '/ai/answering' ? { status: 200, body: db['answering'] }
      : path === '/ai/deployments/active' ? { status: 200, body: db['active'] }
      : path.startsWith('/ai/versions') && method === 'GET' ? { status: 200, body: db['versions'] }
      : path === '/ai/evaluations' && method === 'GET' ? { status: 200, body: db['runs'] }
      : path.startsWith('/ai/evaluations/') && path.endsWith('/results?failed=true') ? { status: 200, body: db['failed'] ?? [] }
      : path.startsWith('/ai/evaluations/') && method === 'GET' ? { status: 200, body: (db['runs'] as any[])[0] }
      : path === '/ai/deployments' && method === 'GET' ? { status: 200, body: db['deployments'] }
      : path === '/ai/monitoring' ? { status: 200, body: db['monitoring'] }
      : path === '/ai/incidents' && method === 'GET' ? { status: 200, body: db['incidents'] }
      : path.endsWith('/affected') ? { status: 200, body: { total: 3, byVersion: [{ deploymentId: 'd1', model: 'extractive', prompt: 'extractive-v1', retriever: 'hybrid@v1/idx', answers: 3 }], items: [], nextCursor: null } }
      : path.startsWith('/ai/incidents/') && method === 'GET' ? { status: 200, body: { ...(db['incidents'] as any[])[0], owner: { displayName: 'Kojo Reviewer' }, affectedAnswers: 3, withdrawnAnswers: 0, timeline: [{ occurredAt: iso(), action: 'ai.incident.open', actorId: 'x' }] } }
      : path.startsWith('/approvals') && method === 'GET' ? { status: 200, body: db['approvals'] ?? [] }
      : method !== 'GET' ? { status: 201, body: {} }
      : { status: 404, body: {} });
    return new Response(JSON.stringify(out.body), { status: out.status });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear(); });

const mount = (ui: React.ReactElement, path = '/') => render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);
const posted = (suffix: string) => calls.find((c) => c.method === 'POST' && c.url.endsWith(suffix));
const openTab = async (name: string) => userEvent.click(await screen.findByRole('tab', { name }));

describe('AI governance: status and kill switch', () => {
  it('says plainly that nothing is approved and the baseline serves citizens', async () => {
    mount(<MlOpsScreen />);
    expect(await screen.findByText(/Built-in baseline/)).toBeTruthy();
    expect(screen.getByText(/Nothing has been approved to replace it/)).toBeTruthy();
    expect(screen.queryByText(/Approved deployment/)).toBeNull();
  });

  it('shows the live deployment with its owner, approver and rollback target', async () => {
    db['active'] = dep();
    mount(<MlOpsScreen />);
    expect(await screen.findByText(/Approved deployment/)).toBeTruthy();
    expect(screen.getByText(/Owner Esi Owner. Approved by Kojo Reviewer/)).toBeTruthy();
    expect(screen.getByText(/Rollback target: built-in baseline/)).toBeTruthy();
  });

  it('lets only reviewers and administrators pause or roll back', async () => {
    db['active'] = dep();
    mount(<MlOpsScreen />);
    await screen.findByText(/Approved deployment/);
    await waitFor(() => expect(calls.some((c) => c.url === '/me')).toBe(true));
    expect(screen.queryByRole('button', { name: 'Pause public answering' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Roll back' })).toBeNull();
    expect(screen.getByText(/Only a reviewer or administrator can pause/)).toBeTruthy();
  });

  it('pauses with a recorded reason, and does nothing if no reason is given', async () => {
    roles = ['REVIEWER'];
    const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce('').mockReturnValueOnce('Wrong attribution reported');
    mount(<MlOpsScreen />);
    const btn = await screen.findByRole('button', { name: 'Pause public answering' });
    await userEvent.click(btn);
    expect(posted('/ai/answering/pause')).toBeUndefined();
    await userEvent.click(btn);
    await waitFor(() => expect(posted('/ai/answering/pause')?.body).toEqual({ reason: 'Wrong attribution reported' }));
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('shows the paused state with its reason and offers to resume', async () => {
    roles = ['ADMIN'];
    db['answering'] = { enabled: false, reason: 'Incident 12', changedAt: iso(), incidentId: null };
    mount(<MlOpsScreen />);
    expect((await screen.findByRole('status')).textContent).toMatch(/Paused.*Incident 12/);
    expect(screen.getByRole('button', { name: 'Resume public answering' })).toBeTruthy();
  });

  it('shows a server refusal instead of pretending it worked', async () => {
    roles = ['REVIEWER'];
    db['answering'] = { enabled: false, reason: 'x', changedAt: iso(), incidentId: null };
    respond = (p, m) => (p === '/ai/answering/resume' && m === 'POST' ? { status: 409, body: { message: '1 critical incident(s) are still open.' } } : undefined);
    vi.spyOn(window, 'prompt').mockReturnValue('Looks fine');
    mount(<MlOpsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Resume public answering' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/critical incident/);
  });

  it('explains a 403 for roles without AI duties', async () => {
    respond = (p) => (p === '/ai/answering' ? { status: 403, body: { message: 'Insufficient role' } } : undefined);
    mount(<MlOpsScreen />);
    expect((await screen.findAllByRole('alert'))[0].textContent).toMatch(/role does not allow/);
  });
});

describe('AI governance: registry', () => {
  const v = (o = {}) => ({ id: 'v1', kind: 'RETRIEVER', name: 'hybrid', version: 'v1', description: null, ownerId: 'u1', ownerName: 'Esi Owner', config: { minScore: 0.15, maxPassages: 5 }, checksum: 'x', status: 'AVAILABLE', createdAt: iso(-1), ...o });

  it('lists versions with owners and offers retirement with a reason', async () => {
    db['versions'] = [v(), v({ id: 'v2', kind: 'DATASET', name: 'gold', config: { caseCount: 9 } })];
    vi.spyOn(window, 'prompt').mockReturnValue('Superseded');
    mount(<MlOpsScreen />);
    await openTab('Registry');
    expect(await screen.findByText('hybrid@v1')).toBeTruthy();
    expect(screen.getAllByText('Esi Owner').length).toBe(2);
    expect(screen.getByText('9 cases')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retire hybrid@v1' }));
    await waitFor(() => expect(posted('/ai/versions/v1/retire')?.body).toEqual({ reason: 'Superseded' }));
  });

  it('registers a version from parsed JSON and refuses invalid JSON before calling the server', async () => {
    mount(<MlOpsScreen />);
    await openTab('Registry');
    await userEvent.click(await screen.findByRole('button', { name: 'Register version' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'strict');
    const setting = within(dialog).getByLabelText('Setting (JSON)');
    await userEvent.clear(setting);
    await userEvent.type(setting, 'not json');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Register' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/not valid JSON/);
    expect(posted('/ai/versions')).toBeUndefined();
    await userEvent.clear(setting);
    await userEvent.click(setting);
    await userEvent.paste('{"minScore": 0.3, "maxPassages": 3}');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Register' }));
    await waitFor(() => expect(posted('/ai/versions')?.body).toMatchObject({ kind: 'RETRIEVER', name: 'strict', version: 'v1', config: { minScore: 0.3, maxPassages: 3 } }));
  });

  it('shows the server explanation when registration is refused', async () => {
    respond = (p, m) => (p === '/ai/versions' && m === 'POST' ? { status: 400, body: { message: 'The system prompt is missing required safeguards' } } : undefined);
    mount(<MlOpsScreen />);
    await openTab('Registry');
    await userEvent.click(await screen.findByRole('button', { name: 'Register version' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'weak');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Register' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/missing required safeguards/);
  });

  it('hides registration from people who cannot build', async () => {
    roles = ['REVIEWER'];
    mount(<MlOpsScreen />);
    await openTab('Registry');
    await screen.findByText(/Nothing is registered yet/);
    await waitFor(() => expect(calls.some((c) => c.url === '/me')).toBe(true));
    expect(screen.queryByRole('button', { name: 'Register version' })).toBeNull();
  });
});

describe('AI governance: evaluations', () => {
  it('reports every group separately, flags small ones, and lists the cases that failed', async () => {
    db['runs'] = [run({ gate: { passed: false, failures: ['Answer quality is 60%, below the required 80%'], warnings: ['Slice language "tw" has only 1 case(s): too few to be reliable'], thresholds: {} } })];
    db['failed'] = [{ id: 'x1', status: 'no_evidence', expectedStatus: 'grounded', language: 'en', answer: null, correct: false, case: { key: 'f3', question: 'water and sanitation funding' } }];
    mount(<MlOpsScreen />);
    await openTab('Evaluations');
    await userEvent.click(await screen.findByRole('button', { name: 'Open report' }));
    const report = await screen.findByRole('region', { name: 'Evaluation report' });
    expect(within(report).getByText('Release gate not passed')).toBeTruthy();
    expect(within(report).getByText(/below the required 80%/)).toBeTruthy();
    expect(within(report).getByText(/Language: tw/)).toBeTruthy();
    expect(within(report).getByText('few cases')).toBeTruthy();
    expect(within(report).getByText('Language: en')).toBeTruthy();
    expect(await within(report).findByText('water and sanitation funding')).toBeTruthy();
  });

  it('reports token use without inventing a cost', async () => {
    db['runs'] = [run({ summary: metrics({ inputTokens: 1200, outputTokens: 300 }) })];
    mount(<MlOpsScreen />);
    await openTab('Evaluations');
    await userEvent.click(await screen.findByRole('button', { name: 'Open report' }));
    expect(await screen.findByText(/1200 input and 300 output tokens/)).toBeTruthy();
    expect(screen.getByText(/cost is not calculated/)).toBeTruthy();
  });

  it('starts an evaluation from registered versions', async () => {
    const mk = (kind: string, name: string) => ({ id: `${name}-id`, kind, name, version: 'v1', ownerName: 'o', ownerId: 'o', description: null, config: {}, checksum: 'c', status: 'AVAILABLE', createdAt: iso() });
    db['versions'] = [mk('DATASET', 'gold'), mk('MODEL', 'extractive'), mk('PROMPT', 'grounded'), mk('RETRIEVER', 'hybrid')];
    mount(<MlOpsScreen />);
    await openTab('Evaluations');
    await userEvent.click(await screen.findByRole('button', { name: 'New evaluation' }));
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(within(dialog).getByLabelText('Dataset').querySelectorAll('option').length).toBeGreaterThan(1));
    for (const [l, v] of [['Dataset', 'gold-id'], ['Model', 'extractive-id'], ['Prompt', 'grounded-id'], ['Retriever', 'hybrid-id']]) await userEvent.selectOptions(within(dialog).getByLabelText(l), v);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(posted('/ai/evaluations')?.body).toEqual({ datasetId: 'gold-id', modelId: 'extractive-id', promptId: 'grounded-id', retrieverId: 'hybrid-id' }));
  });
});

describe('AI governance: deployments', () => {
  it('offers only evaluations that passed the gate and sends the exact combination that was evaluated', async () => {
    db['runs'] = [run({ id: 'ok', gate: { passed: true, failures: [], warnings: [], thresholds: {} } }), run({ id: 'bad', model: ref('claude'), gate: { passed: false, failures: ['x'], warnings: [], thresholds: {} } })];
    mount(<MlOpsScreen />);
    await openTab('Deployments');
    await userEvent.click(await screen.findByRole('button', { name: 'Request deployment' }));
    const dialog = screen.getByRole('dialog');
    const select = within(dialog).getByLabelText(/Evaluation that passed/);
    await waitFor(() => expect(select.querySelectorAll('option').length).toBe(2));
    expect(within(dialog).queryByText(/claude@v1/)).toBeNull();
    await userEvent.selectOptions(select, 'ok');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    await waitFor(() => expect(posted('/ai/deployments')?.body).toEqual({ modelId: 'extractive-id', promptId: 'grounded-id', retrieverId: 'hybrid-id', evalRunId: 'ok' }));
    expect(await screen.findByText(/A reviewer must approve it/)).toBeTruthy();
  });

  it('shows history, including rejections with their reason, and rolls back with a reason', async () => {
    roles = ['REVIEWER'];
    db['deployments'] = [dep(), dep({ id: 'd0', status: 'REJECTED', endedReason: 'Add Ga questions', activatedAt: null })];
    vi.spyOn(window, 'prompt').mockReturnValue('Quality drop');
    mount(<MlOpsScreen />);
    await openTab('Deployments');
    expect(await screen.findByText('Add Ga questions')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Roll back extractive@v1/ }));
    await waitFor(() => expect(posted('/ai/deployments/d1/rollback')?.body).toEqual({ reason: 'Quality drop' }));
  });
});

describe('AI governance: monitoring', () => {
  it('distinguishes healthy, alerting and not-enough-data, and never calls missing data healthy', async () => {
    db['monitoring'] = {
      at: iso(), windowMinutes: 60, deploymentId: 'd1',
      rules: [rule(), rule({ rule: 'unavailable_rate', status: 'firing', message: 'Questions that failed is 20% (alert at 5%)' }), rule({ rule: 'latency_p95', status: 'insufficient_data', message: 'Latency: only 3 question(s)', sampleSize: 3 })],
      alerts: [{ id: 'al1', rule: 'unavailable_rate', scopeKey: '', severity: 'HIGH', metric: 'm', value: 0.2, threshold: 0.05, sampleSize: 40, status: 'OPEN', firedAt: iso(), lastSeenAt: iso(), detail: { message: 'Questions that failed is 20% (alert at 5%)' } }],
    };
    mount(<MlOpsScreen />);
    await openTab('Monitoring');
    const checks = (await screen.findByRole('table', { name: 'Monitoring rules' }));
    expect(within(checks).getByText('OK')).toBeTruthy();
    expect(within(checks).getByText('Alert')).toBeTruthy();
    expect(within(checks).getByText('Not enough data')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Acknowledge Unavailable rate' }));
    await waitFor(() => expect(posted('/ai/alerts/al1/acknowledge')).toBeTruthy());
  });

  it('runs a check on demand', async () => {
    mount(<MlOpsScreen />);
    await openTab('Monitoring');
    await userEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(posted('/ai/monitoring/evaluate')).toBeTruthy());
  });
});

describe('AI governance: incidents and reconstruction', () => {
  const incident = (o = {}) => ({ id: 'i1', title: 'Wrong attribution', description: 'Minister misquoted', severity: 'CRITICAL', status: 'OPEN', scope: { documentId: 'HAN-1000' }, createdAt: iso(-1), resolution: null, ...o });

  it('opens an incident with a scope, offering to pause only to those who may', async () => {
    roles = ['RESEARCHER'];
    mount(<MlOpsScreen />);
    await openTab('Incidents');
    await userEvent.click(await screen.findByRole('button', { name: 'Open an incident' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText(/Pause public answering now/)).toBeNull();
    await userEvent.type(within(dialog).getByLabelText('Title'), 'Misquote');
    await userEvent.type(within(dialog).getByLabelText('What happened'), 'A Minister was misquoted');
    await userEvent.selectOptions(within(dialog).getByLabelText('Severity'), 'HIGH');
    await userEvent.selectOptions(within(dialog).getByLabelText('Affected answers'), 'documentId');
    await userEvent.type(within(dialog).getByLabelText(/Document ID/), 'HAN-1000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open incident' }));
    await waitFor(() => expect(posted('/ai/incidents')?.body).toEqual({ title: 'Misquote', description: 'A Minister was misquoted', severity: 'HIGH', scope: { documentId: 'HAN-1000' } }));
  });

  it('shows how many answers an incident affects, by version, and withdraws them with a recorded reason', async () => {
    roles = ['REVIEWER'];
    db['incidents'] = [incident()];
    vi.spyOn(window, 'prompt').mockReturnValue('Misattributed quotation');
    mount(<MlOpsScreen />);
    await openTab('Incidents');
    await userEvent.click(await screen.findByRole('button', { name: 'Open' }));
    const panel = await screen.findByRole('region', { name: 'Incident detail' });
    expect(await within(panel).findByText(/answer\(s\) affected/)).toBeTruthy();
    expect(within(panel).getByText('hybrid@v1/idx')).toBeTruthy();
    await userEvent.click(within(panel).getByRole('button', { name: 'Withdraw affected answers' }));
    await waitFor(() => expect(posted('/ai/incidents/i1/withdraw-answers')?.body).toEqual({ note: 'Misattributed quotation' }));
  });

  it('reconstructs an answer and names exactly what is missing', async () => {
    respond = (p) => (p.startsWith('/ai/answers/') ? { status: 200, body: {
      answerId: 'ans-1', asked: { question: 'What about fuel?', language: 'en', at: iso() }, seen: { status: 'grounded', answer: 'Fuel rose [1].', failureReason: null },
      sources: [{ n: 1, documentId: 'HAN-1000', title: 'Fuel debate', documentVersion: 2, text: 'Fuel prices rose sharply.', snapshotValid: true, document: { unchangedSince: false } }],
      version: { model: 'extractive', prompt: 'extractive-v1', retriever: 'hybrid@v1/idx', deployment: { id: 'abcdef123456', status: 'ACTIVE', approval: { decision: 'APPROVED', approver: { displayName: 'Kojo Reviewer' } } } },
      withdrawn: null, completeness: { ok: false, missing: ['ask_audit_event_missing'] },
    } } : undefined);
    mount(<MlOpsScreen />);
    await openTab('Incidents');
    await userEvent.type(await screen.findByLabelText('Answer ID'), 'ans-1');
    await userEvent.click(screen.getByRole('button', { name: 'Reconstruct' }));
    expect(await screen.findByText(/Missing: ask_audit_event_missing/)).toBeTruthy();
    expect(screen.getByText(/approval Approved by Kojo Reviewer/)).toBeTruthy();
    expect(screen.getByText(/the record has changed since/)).toBeTruthy();
  });

  it('runs the reconstruction sample test and reports gaps', async () => {
    respond = (p, m) => (p === '/ai/reconstruction-test' && m === 'POST' ? { status: 200, body: { sampled: 25, passed: 24, failed: 1, ok: false, failures: [{ answerId: 'abcdef12-0000', missing: ['sources_not_recorded'] }] } } : undefined);
    mount(<MlOpsScreen />);
    await openTab('Incidents');
    await userEvent.click(await screen.findByRole('button', { name: /Test a random sample/ }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Gaps found.*24 of 25.*sources_not_recorded/);
  });
});

describe('Approvals of AI deployments', () => {
  const aiApproval = (o = {}) => ({
    id: 'ap1', objectType: 'ai_deployment', objectId: 'd9', objectLabel: 'AI deployment: extractive@v1 + grounded@v1 + hybrid@v1', action: 'deploy', decision: 'PENDING', reason: null, requesterId: 'u-res', requester: { id: 'u-res', displayName: 'Esi' }, approver: null, createdAt: iso(), decidedAt: null,
    evidence: { evalRunId: 'r1', summary: { n: 9, answerQuality: 0.89, retrievalRecall: 1, citationCompleteness: 1, refusalQuality: 1, harmfulOutputs: 0, latencyP95Ms: 90 }, gate: { passed: true, failures: [], warnings: ['Slice language "tw" has only 1 case(s)'] }, slices: [{ dimension: 'language', value: 'tw', n: 1, answerQuality: 1, underpowered: true }], releaseThresholds: { minAnswerQuality: 0.5 } }, ...o,
  });

  it('shows the evaluation evidence and will not approve until the reviewer confirms they read it', async () => {
    roles = ['REVIEWER'];
    db['approvals'] = [aiApproval()];
    mount(<ApprovalsScreen />);
    expect(await screen.findByText('Deploy to the public')).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: /Approve AI deployment/ }));
    expect(posted('/approvals/ap1/decision')).toBeUndefined();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Answer quality 89% over 9 cases/)).toBeTruthy();
    expect(within(dialog).getByText(/Language tw: quality 100% over 1 case\(s\) \(too few cases to rely on\)/)).toBeTruthy();
    expect(within(dialog).getByText(/minAnswerQuality 0.5/)).toBeTruthy();
    const approve = within(dialog).getByRole('button', { name: 'Approve deployment' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    await userEvent.click(within(dialog).getByRole('checkbox'));
    await userEvent.click(approve);
    await waitFor(() => expect(posted('/approvals/ap1/decision')?.body).toEqual({ decision: 'APPROVED', reviewedEvidence: true }));
  });

  it('refuses to approve a deployment with no evidence attached', async () => {
    roles = ['REVIEWER'];
    db['approvals'] = [aiApproval({ evidence: null })];
    mount(<ApprovalsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: /Approve AI deployment/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/evidence is missing/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('checkbox'));
    expect((within(dialog).getByRole('button', { name: 'Approve deployment' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('still approves ordinary records in one step', async () => {
    roles = ['REVIEWER'];
    db['approvals'] = [{ ...aiApproval(), id: 'ap2', objectType: 'bill', objectLabel: 'Some Bill', action: 'publish', evidence: null }];
    mount(<ApprovalsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve Some Bill' }));
    await waitFor(() => expect(posted('/approvals/ap2/decision')?.body).toEqual({ decision: 'APPROVED' }));
  });
});

describe('the console', () => {
  it('has an AI governance page instead of the old placeholder', async () => {
    mount(<App />, '/mlops');
    expect(await screen.findByRole('heading', { name: 'AI governance', level: 3 })).toBeTruthy();
    expect(screen.queryByText('Not available yet')).toBeNull();
    expect(screen.getByRole('tablist', { name: 'AI governance sections' })).toBeTruthy();
  });
});
