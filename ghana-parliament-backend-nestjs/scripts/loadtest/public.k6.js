// k6 load test for the public API. Thresholds are the pass/fail criteria; adjust them to the
// release targets once Parliament agrees the numbers (open decision: latency and cost thresholds).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3998/api/v1/public';
const grounded = new Counter('answers_grounded');

export const options = {
  scenarios: {
    citizens: { executor: 'constant-vus', vus: 20, duration: '30s' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:ask}': ['p(95)<1500'],
    'http_req_duration{name:search}': ['p(95)<800'],
    'http_req_duration{name:list}': ['p(95)<500'],
    checks: ['rate>0.99'],
  },
};

const QUESTIONS = [
  'What did Parliament say about fuel prices?',
  'debates on the cost of living',
  'water and sanitation funding',
  'healthcare budget allocation',
  'education policy free senior high school',
];

export default function () {
  const q = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
  const headers = { 'Content-Type': 'application/json' };

  const a = http.post(`${BASE}/answers`, JSON.stringify({ question: q }), { headers, tags: { name: 'ask' } });
  const ok = check(a, { 'ask 200': (r) => r.status === 200, 'has status': (r) => !!r.json('status') });
  if (ok && a.json('status') === 'grounded') {
    grounded.add(1);
    check(a, { 'grounded answers cite sources': (r) => r.json('citations').length > 0 });
  }

  const s = http.get(`${BASE}/search?q=${encodeURIComponent(q)}`, { tags: { name: 'search' } });
  check(s, { 'search 200': (r) => r.status === 200 });

  const l = http.get(`${BASE}/documents?pageSize=10`, { tags: { name: 'list' } });
  check(l, { 'list 200': (r) => r.status === 200 });
  sleep(0.5);
}
