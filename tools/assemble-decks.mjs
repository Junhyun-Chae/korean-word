// builds data/decks/*.json and index.json from the chunks in data/decks/_gen/
// usage: node tools/assemble-decks.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GEN = join(ROOT, 'data', 'decks', '_gen');
const OUT = join(ROOT, 'data', 'decks');

const DECKS = [
  { id: 'topik1', name: '初級 (TOPIK I)', desc: 'ハングル学習者の最重要基礎語彙', level: 'TOPIK 1〜2' },
  { id: 'topik2', name: '中級 (TOPIK II)', desc: '日常・社会生活の中級語彙', level: 'TOPIK 3〜4' },
  { id: 'topik3', name: '上級 (TOPIK II)', desc: '新聞・論説に対応する上級語彙', level: 'TOPIK 5〜6' },
  { id: 'daily', name: '日常会話・基礎', desc: '会話でそのまま使える表現と基礎単語', level: '入門〜初級' },
  { id: 'travel', name: '旅行韓国語', desc: '旅行の場面で役立つ実戦単語・表現', level: '入門〜初級' },
];

const hasHangul = (s) => /[가-힣]/.test(s || '');
const hasJapanese = (s) => /[ぁ-んァ-ヶ一-龯々ー]/.test(s || '');
const termOk = (s) => /^[가-힣]+( [가-힣]+)*$/.test((s || '').trim());

const files = readdirSync(GEN).filter((f) => /\.json$/.test(f) && !f.startsWith('_'));
const index = [];
let totalBad = 0;

for (const d of DECKS) {
  const mine = files.filter((f) => f.startsWith(`${d.id}-`)).sort();
  const seen = new Set();
  const words = [];
  let bad = 0, dupes = 0, exDropped = 0;
  for (const f of mine) {
    let arr;
    try { arr = JSON.parse(readFileSync(join(GEN, f), 'utf8')); }
    catch (e) { console.error(`✗ ${f}: JSON parse failed — ${e.message}`); continue; }
    if (!Array.isArray(arr)) { console.error(`✗ ${f}: not an array`); continue; }
    for (const w of arr) {
      const t = String(w?.t || '').trim();
      const p = String(w?.p || '').trim();
      const m = String(w?.m || '').trim();
      let ex = String(w?.ex || '').trim();
      let exk = String(w?.exk || '').trim();
      // headword must be Hangul; gloss must contain Japanese
      if (!termOk(t) || !m || !hasJapanese(m)) { bad++; continue; }
      // example must be Korean and its translation Japanese, else drop the example pair
      if (ex && (!hasHangul(ex) || !exk || !hasJapanese(exk))) { ex = ''; exk = ''; exDropped++; }
      if (seen.has(t)) { dupes++; continue; }
      seen.add(t);
      words.push({ t, p, m, ex, exk });
    }
  }
  totalBad += bad;
  // fail instead of writing a partial set (sw.js precaches every deck)
  if (!words.length) { console.error(`✗ FATAL deck ${d.id}: 0 words`); process.exit(1); }
  const deck = { id: d.id, name: d.name, desc: d.desc, level: d.level, count: words.length, words };
  writeFileSync(join(OUT, `${d.id}.json`), JSON.stringify(deck));
  index.push({ id: d.id, name: d.name, desc: d.desc, level: d.level, count: words.length });
  console.log(`✓ ${d.id}: files=${mine.length} words=${words.length} dropped=${bad} dupes=${dupes} exDropped=${exDropped}`);
}

writeFileSync(join(OUT, 'index.json'), JSON.stringify(index));
console.log(`\nindex.json: ${index.length} decks, ${index.reduce((s, d) => s + d.count, 0)} words total, dropped=${totalBad}`);
