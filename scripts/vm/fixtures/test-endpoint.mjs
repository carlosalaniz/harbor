// Test-owned HTTP endpoint for the live n8n demo: answers 200 only with the expected bearer token.
// Runs on the VM bound to a Docker network gateway address so the n8n container can reach it.
import { createServer } from 'node:http';
const [host, portArg] = process.argv.slice(2);
const port = Number(portArg);
let hits = [];
createServer((req, res) => {
  if (req.url === '/__hits') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(hits));
    return;
  }
  const ok = req.headers['authorization'] === 'Bearer harbor-test-token-123';
  hits.push({ at: new Date().toISOString(), path: req.url, ok });
  if (hits.length > 100) hits = hits.slice(-100);
  res.statusCode = ok ? 200 : 401;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok, path: req.url, at: new Date().toISOString(), marker: ok ? 'credentialed-call-accepted' : 'missing-or-wrong-credential' }));
}).listen(port, host, () => console.log(`test endpoint on ${host}:${port}`));
