// Sync between devices through /api/sync (_worker.js + KV).
// Data is encrypted with a key derived from the passphrase before upload.
//
// merge:
//   words   - newer updatedAt wins
//   cards   - the more-studied copy wins (reps, then due)
//   reviews - union by (cardId, ts)
//   deletes - tombstones; a delete only wins over an older edit
// settings (theme, input mode, passphrase) are not synced
import * as db from './db.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const DAY = 86400000;
const TOMBSTONE_TTL = 90 * DAY;
const MIN_PASS = 8;

function err(msg, code) { const e = new Error(msg); e.code = code; return e; }

function b64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKeys(pass) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey', 'deriveBits']);
  const aes = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('kokuin-sync-v1'), iterations: 150000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const idBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('kokuin-sync-id'), iterations: 150000, hash: 'SHA-256' }, base, 256);
  const id = [...new Uint8Array(idBits)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { aes, id };
}

async function encrypt(aes, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode(JSON.stringify(obj)));
  return `${b64(iv)}.${b64(ct)}`;
}
async function decrypt(aes, s) {
  const [ivs, cts] = String(s).split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivs) }, aes, unb64(cts));
  return JSON.parse(dec.decode(pt));
}

async function snapshot() {
  return {
    v: 1,
    words: await db.all('words'),
    cards: await db.all('cards'),
    reviews: (await db.all('reviews')).map(({ id, ...r }) => r),
    streak: (await db.getMeta('streak', { current: 0, longest: 0, last: null })) || {},
    counters: (await db.getMeta('counters', {})) || {},
    tombstones: (await db.getMeta('tombstones', {})) || {},
  };
}

const wTime = (w) => w.updatedAt || w.createdAt || 0;
const stableLess = (cur, cand) => JSON.stringify(cand) > JSON.stringify(cur); // deterministic, commutative
function cardMoreStudied(c, cur) {
  if ((c.reps || 0) !== (cur.reps || 0)) return (c.reps || 0) > (cur.reps || 0);
  if ((c.due || 0) !== (cur.due || 0)) return (c.due || 0) > (cur.due || 0);
  return stableLess(cur, c);
}

export function mergeTombstones(...srcs) {
  const now = Date.now();
  const tomb = {};
  for (const src of srcs) {
    for (const [id, ts] of Object.entries(src || {})) {
      const t = Number(ts) || 0;
      if (now - t <= TOMBSTONE_TTL) tomb[id] = Math.max(tomb[id] || 0, t);
    }
  }
  return tomb;
}
export function mergeStreak(sa = {}, sb = {}) {
  let s;
  if ((sb.last || 0) > (sa.last || 0)) s = { ...sb };
  else if ((sa.last || 0) > (sb.last || 0)) s = { ...sa };
  else s = (sb.current || 0) > (sa.current || 0) ? { ...sb } : { ...sa }; // tie: keep the longer chain
  s.longest = Math.max(sa.longest || 0, sb.longest || 0, s.current || 0);
  return s;
}
export function mergeCounters(ca = {}, cb = {}) {
  const out = {};
  for (const src of [ca, cb]) {
    for (const [day, v] of Object.entries(src || {})) {
      if (!v || typeof v !== 'object') continue;
      out[day] = out[day] || { newWords: 0, reviews: 0 };
      out[day].newWords = Math.max(out[day].newWords, Number(v.newWords) || 0);
      out[day].reviews = Math.max(out[day].reviews, Number(v.reviews) || 0);
    }
  }
  return out;
}

export function mergeData(a, b) {
  if (!b || typeof b !== 'object') b = {};
  const tomb = mergeTombstones(a.tombstones, b.tombstones);

  const words = new Map();
  for (const w of [...(a.words || []), ...(b.words || [])]) {
    if (!w || !w.id) continue;
    if (tomb[w.id] && tomb[w.id] >= wTime(w)) continue; // deleted after its last edit
    const cur = words.get(w.id);
    if (!cur) { words.set(w.id, w); continue; }
    const tw = wTime(w), tc = wTime(cur);
    if (tw > tc || (tw === tc && stableLess(cur, w))) words.set(w.id, w);
  }

  const wordIds = new Set(words.keys());
  const leechById = new Map(); // OR the leech flag across both sides
  const cards = new Map();
  for (const c of [...(a.cards || []), ...(b.cards || [])]) {
    if (!c || !c.id || !wordIds.has(c.wordId)) continue;
    leechById.set(c.id, (leechById.get(c.id) || false) || !!c.leech);
    const cur = cards.get(c.id);
    if (!cur || cardMoreStudied(c, cur)) cards.set(c.id, c);
  }
  for (const c of cards.values()) {
    const w = words.get(c.wordId);
    if (w) c.deck = w.deck;          // deck follows the word
    c.leech = leechById.get(c.id) || false;
  }

  const cardIds = new Set(cards.keys());
  const seen = new Set();
  const reviews = [];
  for (const r of [...(a.reviews || []), ...(b.reviews || [])]) {
    if (!r || !r.cardId || !cardIds.has(r.cardId)) continue;
    const k = `${r.cardId}@${r.ts}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const { id, ...rest } = r;
    reviews.push(rest);
  }

  return {
    v: 1,
    words: [...words.values()],
    cards: [...cards.values()],
    reviews,
    streak: mergeStreak(a.streak, b.streak),
    counters: mergeCounters(a.counters, b.counters),
    tombstones: tomb,
  };
}

// apply against the current DB (re-read each record) so changes made during the request aren't lost
async function applyMerged(m) {
  for (const w of m.words) {
    const cur = await db.get('words', w.id);
    if (!cur || wTime(w) >= wTime(cur)) await db.put('words', w); // never overwrite a newer local edit
  }
  for (const c of m.cards) {
    const cur = await db.get('cards', c.id);
    const localMoreStudied = cur && ((cur.reps || 0) > (c.reps || 0)
      || ((cur.reps || 0) === (c.reps || 0) && (cur.due || 0) > (c.due || 0)));
    if (!localMoreStudied) await db.put('cards', c); // never roll a card back
  }
  // only delete tombstoned ids that weren't edited after the delete
  for (const id of Object.keys(m.tombstones)) {
    const w = await db.get('words', id);
    if (w && m.tombstones[id] >= wTime(w)) {
      await db.del('words', id);
      const cs = await db.allByIndex('cards', 'wordId', id);
      for (const cc of cs) await db.del('cards', cc.id);
    }
  }
  const have = new Set((await db.all('reviews')).map((r) => `${r.cardId}@${r.ts}`));
  const fresh = m.reviews.filter((r) => !have.has(`${r.cardId}@${r.ts}`));
  if (fresh.length) await db.bulkPut('reviews', fresh);
  // meta: merge again with the current values
  await db.setMeta('streak', mergeStreak((await db.getMeta('streak', {})) || {}, m.streak));
  await db.setMeta('counters', mergeCounters((await db.getMeta('counters', {})) || {}, m.counters));
  await db.setMeta('tombstones', mergeTombstones((await db.getMeta('tombstones', {})) || {}, m.tombstones));
}

// pull, merge, apply, push. Errors have a .code.
// opts.forceReset: overwrite the server with this device's data
// opts.allowDestroy: skip the "too many deletes" check
export async function sync(pass, opts = {}) {
  if (!pass || pass.length < MIN_PASS) throw err(`同期パスワードは${MIN_PASS}文字以上にしてください`, 'weak');
  const { aes, id } = await deriveKeys(pass);
  const local = await snapshot();

  let remote = null;
  if (!opts.forceReset) {
    const res = await fetch(`./api/sync/${id}`, { cache: 'no-store' });
    if (res.status === 503) throw err('サーバーに同期ストレージ(KV)がまだ接続されていません — READMEの同期設定を参照', 'kv');
    if (!res.ok) throw err(`サーバーエラー (${res.status})`, 'http');
    const text = (await res.text()).trim();
    if (text && text !== 'null') {
      let body;
      try { body = JSON.parse(text); } catch { throw err('サーバーの応答を解釈できません — しばらくしてからもう一度お試しください', 'parse'); }
      if (body && body.data) {
        try { remote = await decrypt(aes, body.data); }
        catch { throw err('保存されたデータを復号できません(パスワードが違うか、破損しています)', 'decrypt'); }
      } else if (body !== null) {
        throw err('サーバーデータの形式が正しくありません', 'format'); // don't silently overwrite
      }
    }
  }

  const merged = mergeData(local, opts.forceReset ? null : remote);

  // refuse to drop more than half the words unless allowDestroy is set
  if (!opts.allowDestroy && local.words.length >= 5 && merged.words.length < local.words.length * 0.5) {
    throw err(`同期すると単語が ${local.words.length}→${merged.words.length} 語に大きく減ります。意図したものか確認してください。`, 'destroy');
  }

  await applyMerged(merged);

  const localIds = new Set(local.words.map((w) => w.id));
  const pulled = merged.words.filter((w) => !localIds.has(w.id)).length;

  const put = await fetch(`./api/sync/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, data: await encrypt(aes, { ...merged, ts: Date.now() }) }),
  });
  if (!put.ok) throw err(`アップロード失敗 (${put.status})`, 'put');

  return { words: merged.words.length, pulledWords: pulled };
}
