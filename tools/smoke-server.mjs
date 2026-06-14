// static server for smoke-test.html; POST /smoke-report saves the log
// usage: node tools/smoke-server.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 8766;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

const kv = new Map(); // fake /api/sync

createServer(async (req, res) => {
  const syncMatch = (req.url || '').match(/^\/api\/sync\/([a-f0-9]{64})$/);
  if (syncMatch) {
    const key = syncMatch[1];
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(kv.get(key) || 'null');
      return;
    }
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        kv.set(key, body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(405).end();
    return;
  }
  if (req.method === 'POST' && req.url === '/smoke-report') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      writeFileSync('/tmp/ingrain-smoke-report.txt', body);
      console.log('REPORT RECEIVED');
      res.writeHead(204).end();
    });
    return;
  }
  const path = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`smoke server on :${PORT}`));
