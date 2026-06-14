// Cloudflare worker: serves the static files plus a small sync API on KV (SYNC_KV).
// The client only ever uploads encrypted data.

const JSON_H = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const MAX_BLOB = 20 * 1024 * 1024; // KV value limit is 25 MiB; stay under it

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/sync/')) {
      if (!env.SYNC_KV) {
        return new Response(JSON.stringify({ error: 'kv-not-bound' }), { status: 503, headers: JSON_H });
      }
      const key = url.pathname.split('/')[3] || '';
      if (!/^[a-f0-9]{64}$/.test(key)) {
        return new Response(JSON.stringify({ error: 'bad-key' }), { status: 400, headers: JSON_H });
      }
      if (request.method === 'GET') {
        const v = await env.SYNC_KV.get('s:' + key);
        return new Response(v || 'null', { status: 200, headers: JSON_H });
      }
      if (request.method === 'PUT') {
        const body = await request.text();
        if (!body || body.length > MAX_BLOB) {
          return new Response(JSON.stringify({ error: 'too-large' }), { status: 413, headers: JSON_H });
        }
        await env.SYNC_KV.put('s:' + key, body);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_H });
      }
      return new Response(JSON.stringify({ error: 'method' }), { status: 405, headers: JSON_H });
    }
    return env.ASSETS.fetch(request);
  },
};
