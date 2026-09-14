// Headless local-web journey: drives the browser API the page uses, times every turn.
// usage: node journey.mjs <install-dir> [steps] ; env WEB_URL (default http://127.0.0.1:3210), TURN_TIMEOUT_MS
import fs from 'node:fs';
const INSTALL = process.argv[2];
const ONLY = new Set((process.argv[3] ?? '').split(',').filter(Boolean));
const BASE = process.env.WEB_URL ?? 'http://127.0.0.1:3210';
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS ?? 15 * 60_000);
const TOKEN = fs.readFileSync(`${INSTALL}/data/local-web/token`, 'utf8').trim();
const H = { 'x-nanoclaw-local-web-token': TOKEN, 'content-type': 'application/json', origin: BASE };
const log = [];
const t0 = Date.now();
const stamp = () => new Date().toISOString().slice(11, 19);
function record(step, ok, ms, note = '') { log.push({ step, ok, ms, note }); console.log(`[${stamp()}] ${ok ? 'PASS' : 'FAIL'} ${step} ${ms}ms ${note}`.slice(0, 300)); }

async function api(method, path, body) {
  const r = await fetch(`${BASE}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
}
const catalog = async () => (await api('GET', '/api/conversations')).json;
const byName = async (name) => (await catalog()).conversations.find((c) => c.agentName === name);

// One SSE subscription per conversation; events are buffered so a reply that arrives
// before we start waiting is not lost. Queued events flush on connect.
const streams = new Map();
function subscribe(conversationId) {
  if (streams.has(conversationId)) return streams.get(conversationId);
  const s = { events: [], waiters: [], abort: new AbortController() };
  streams.set(conversationId, s);
  (async () => {
    // The page reconnects on any stream end; queued events flush on reconnect, so nothing is lost.
    while (!s.abort.signal.aborted) {
      try {
        const r = await fetch(`${BASE}/events?conversationId=${encodeURIComponent(conversationId)}`, { headers: H, signal: s.abort.signal });
        const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i; while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            for (const line of frame.split('\n')) if (line.startsWith('data: ')) { try { const ev = JSON.parse(line.slice(6)); ev._at = Date.now(); s.events.push(ev); s.waiters.splice(0).forEach((w) => w()); } catch {} }
          }
        }
      } catch (e) { if (e.name === 'AbortError') return; console.error(`[${stamp()}] stream ${conversationId} dropped (${e.message}); reconnecting`); }
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
  return s;
}
async function waitEvent(conversationId, pred, timeoutMs = TURN_TIMEOUT_MS, since = Date.now()) {
  const s = subscribe(conversationId); const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ev = s.events.find((e) => e._at >= since - 1000 && !e._seen && pred(e));
    if (ev) { ev._seen = true; return ev; }
    if (Date.now() > deadline) return null;
    await new Promise((res) => { s.waiters.push(res); setTimeout(res, 2000); });
  }
}
// Replies queued server-side while no client listened are flushed on connect; they must not
// be mistaken for the answer to the message we are about to send.
async function drain(conversationId) {
  const s = subscribe(conversationId);
  await new Promise((r) => setTimeout(r, 1500));
  for (const e of s.events) e._seen = true;
}
async function send(conversationId, text, opts = {}) {
  await drain(conversationId);
  const started = Date.now();
  const r = await api('POST', '/api/messages', { conversationId, text });
  if (r.status >= 300) return { ok: false, ms: 0, note: `POST ${r.status} ${JSON.stringify(r.json).slice(0, 120)}` };
  const ev = await waitEvent(conversationId, (e) => e.type === 'reply' || (opts.acceptQuestion && e.type === 'question'), opts.timeoutMs, started);
  return { ok: !!ev, ms: Date.now() - started, ev, note: ev ? `${ev.type}: ${(ev.text ?? ev.question ?? '').replace(/\s+/g, ' ').slice(0, 140)}` : 'timeout' };
}
const run = async (name, fn) => { if (ONLY.size && !ONLY.has(name)) return; const started = Date.now(); try { const res = await fn(); record(name, res?.ok !== false, Date.now() - started, res?.note ?? ''); } catch (e) { record(name, false, Date.now() - started, `error: ${e.message}`); } };

const parent = (await catalog()).conversations.find((c) => c.isLegacy) ?? (await catalog()).conversations[0];
if (!parent) { console.error('no conversations'); process.exit(2); }
console.log(`[${stamp()}] parent conversation ${parent.conversationId} (${parent.agentName}); catalog: ${(await catalog()).conversations.map((c) => c.agentName).join(', ')}`);
subscribe(parent.conversationId);

await run('welcome', async () => { const ev = await waitEvent(parent.conversationId, (e) => e.type === 'reply', 10 * 60_000, t0 - 20 * 60_000); return { ok: !!ev, note: ev ? ev.text.replace(/\s+/g, ' ').slice(0, 120) : 'no welcome within 10 min' }; });
await run('hi-cold', () => send(parent.conversationId, 'hi'));
await run('hi-warm', () => send(parent.conversationId, 'What is 12 times 12? One line.'));
await run('ui-create-agent', async () => { const r = await api('POST', '/api/agents', { name: 'test-agent', sourceConversationId: parent.conversationId }); const c = await byName('test-agent'); return { ok: r.status < 300 && !!c, note: `status ${r.status}, in catalog: ${!!c}` }; });
await run('child-direct-chat', async () => { const c = await byName('test-agent'); return send(c.conversationId, 'hello, who are you? one line.'); });
await run('delegate-and-relay', async () => {
  const started = Date.now();
  const r1 = await send(parent.conversationId, 'Create an agent called ollama-child that fetches the featured article from ynet.co.il. Then ask it to fetch the article and report its title to you, and tell me the title when it replies.', { timeoutMs: 12 * 60_000 });
  const child = await byName('ollama-child'); if (child) subscribe(child.conversationId);
  const relay = await waitEvent(parent.conversationId, (e) => e.type === 'reply' && /title|ynet|article|כותרת/i.test(e.text), 14 * 60_000, started);
  const misrouted = child ? (streams.get(child.conversationId)?.events ?? []).filter((e) => e.type === 'reply') : [];
  return { ok: !!relay, note: `first reply ${r1.ms}ms; child created: ${!!child}; relay ${relay ? Date.now() - started + 'ms: ' + relay.text.replace(/\s+/g, ' ').slice(0, 120) : 'NONE'}; replies landing in child conversation: ${misrouted.length}` };
});
await run('web-search-fetch', () => send(parent.conversationId, 'Use web search to find the current top headline on ynet.co.il, then fetch that page and give me one sentence about it.', { timeoutMs: 12 * 60_000 }));
await run('ncl-delete-approval', async () => {
  const started = Date.now(); const target = await byName('test-agent'); if (!target) return { ok: false, note: 'test-agent missing' };
  const first = await send(parent.conversationId, 'Delete the agent named test-agent: run `ncl groups list` to find its id, then `ncl groups delete --id <id>`. Do not ask me to confirm; just run it.', { acceptQuestion: true, timeoutMs: 12 * 60_000 });
  let q = first.ev?.type === 'question' ? first.ev : await waitEvent(parent.conversationId, (e) => e.type === 'question', 3 * 60_000, started);
  if (!q) return { ok: false, note: `no approval card; first reply: ${first.note}` };
  const approve = q.options.findIndex((o) => /approve|allow|yes/i.test(o.label + o.selectedLabel));
  const a = await api('POST', '/api/actions', { conversationId: parent.conversationId, questionId: q.questionId, option: approve >= 0 ? approve : 0 });
  const res = await waitEvent(parent.conversationId, (e) => e.type === 'reply', 6 * 60_000, Date.now());
  const gone = !(await byName('test-agent'));
  return { ok: a.status < 300 && gone, note: `card options ${q.options.map((o) => o.label).join('|')}; action ${a.status}; removed from catalog: ${gone}; follow-up: ${res ? res.text.slice(0, 80) : 'none'}` };
});
await run('sidebar-delete-child', async () => { const c = await byName('ollama-child'); if (!c) return { ok: false, note: 'ollama-child missing' }; const r = await api('DELETE', '/api/agents', { conversationId: c.conversationId }); return { ok: r.status < 300 && !(await byName('ollama-child')), note: `status ${r.status}` }; });
await run('sidebar-delete-last', async () => { const r = await api('DELETE', '/api/agents', { conversationId: parent.conversationId }); const left = (await catalog()).conversations.length; return { ok: r.status < 300 && left === 0, note: `status ${r.status}; conversations left: ${left}` }; });

for (const s of streams.values()) s.abort.abort();
fs.writeFileSync(`${process.env.JOURNEY_OUT ?? '/tmp'}/journey-${Date.now()}.json`, JSON.stringify(log, null, 2));
console.log(`\n${log.filter((l) => l.ok).length}/${log.length} steps passed; total ${Math.round((Date.now() - t0) / 1000)}s`);
process.exit(log.every((l) => l.ok) ? 0 : 1);
