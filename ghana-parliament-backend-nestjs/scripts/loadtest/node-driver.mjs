// Dependency-free load driver: N concurrent clients for T seconds against the public API.
// Used as a cross-check on k6 and where k6 is not installed. Prints throughput and latency percentiles.
const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)] : null);
const QUESTIONS = ['What did Parliament say about fuel prices?', 'debates on the cost of living', 'water and sanitation funding', 'healthcare budget allocation', 'education policy free senior high school'];

export async function drive(base, { clients = 20, seconds = 20, thinkMs = 0 } = {}) {
  const lat = { ask: [], search: [], list: [] };
  const errors = { ask: 0, search: 0, list: 0 };
  let grounded = 0;
  const end = Date.now() + seconds * 1000;
  const timed = async (kind, fn) => {
    const t = performance.now();
    try {
      const r = await fn();
      lat[kind].push(performance.now() - t);
      if (!r.ok) errors[kind]++;
      return r;
    } catch {
      errors[kind]++;
    }
  };
  const worker = async () => {
    while (Date.now() < end) {
      const q = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
      const a = await timed('ask', () => fetch(`${base}/answers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }) }));
      if (a?.ok && (await a.clone().json()).status === 'grounded') grounded++;
      await timed('search', () => fetch(`${base}/search?q=${encodeURIComponent(q)}`));
      await timed('list', () => fetch(`${base}/documents?pageSize=10`));
      if (thinkMs) await new Promise((r) => setTimeout(r, thinkMs));
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: clients }, worker));
  const secs = (performance.now() - t0) / 1000;
  const out = {};
  for (const k of Object.keys(lat)) out[k] = { n: lat[k].length, perSec: +(lat[k].length / secs).toFixed(1), p50: Math.round(pct(lat[k], 50) ?? 0), p95: Math.round(pct(lat[k], 95) ?? 0), p99: Math.round(pct(lat[k], 99) ?? 0), errors: errors[k] };
  return { clients, seconds: +secs.toFixed(1), grounded, ...out };
}
