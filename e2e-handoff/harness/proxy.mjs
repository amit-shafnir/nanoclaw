// Logging reverse proxy: records every request body and the full streamed response body with timings.
import http from 'node:http'; import fs from 'node:fs';
const [,, listenPort = '11437', upstream = 'http://127.0.0.1:11436', outDir = '.'] = process.argv;
let n = 0;
http.createServer(async (req, res) => {
  const id = `${Date.now()}-${String(++n).padStart(3, '0')}`; const t0 = Date.now();
  const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks);
  const meta = { id, method: req.method, url: req.url, headers: req.headers, requestBytes: body.length, started: new Date(t0).toISOString() };
  const isMsg = req.url.startsWith('/v1/messages');
  if (isMsg) fs.writeFileSync(`${outDir}/${id}.request.json`, body);
  let up;
  try {
    up = await fetch(upstream + req.url, { method: req.method, headers: { ...req.headers, host: undefined }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, duplex: 'half' });
  } catch (e) { res.writeHead(502); res.end(String(e)); fs.appendFileSync(`${outDir}/index.log`, JSON.stringify({ ...meta, error: String(e) }) + '\n'); return; }
  res.writeHead(up.status, Object.fromEntries([...up.headers].filter(([k]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(k))));
  const out = isMsg ? fs.createWriteStream(`${outDir}/${id}.response.txt`) : null;
  let bytes = 0, events = 0, firstByteAt = null, lastByteAt = null;
  if (up.body) for await (const chunk of up.body) { bytes += chunk.length; const now = Date.now(); firstByteAt ??= now; lastByteAt = now; events += (chunk.toString().match(/^event: /gm) || []).length; res.write(chunk); out?.write(chunk); }
  res.end(); out?.end();
  fs.appendFileSync(`${outDir}/index.log`, JSON.stringify({ ...meta, status: up.status, responseBytes: bytes, sseEvents: events, ttfbMs: firstByteAt ? firstByteAt - t0 : null, totalMs: Date.now() - t0, lastByteMs: lastByteAt ? lastByteAt - t0 : null }) + '\n');
}).listen(Number(listenPort), '127.0.0.1', () => console.log(`proxy ${listenPort} -> ${upstream}, logs in ${outDir}`));
