// auto-fill for a Korean word: built-in decks, then Google (gtx), then MyMemory.
// the katakana reading is generated locally (hangul.js)
import { loadIndex, loadDeck } from './decklib.js';
import { toKatakana } from './hangul.js';

async function jget(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

// part-of-speech labels (gtx returns them in Japanese)
const POS_ABBR = {
  名: '名', 動: '動', 形: '形', 副: '副', 数: '数', 代: '代', 冠: '冠', 感: '感', 助: '助', 句: '句',
  名詞: '名', 動詞: '動', 形容詞: '形', 副詞: '副', 数詞: '数', 代名詞: '代', 代詞: '代',
  連体詞: '冠', 冠形詞: '冠', 感動詞: '感', 感嘆詞: '感', 助詞: '助', 接続詞: '副', 間投詞: '感',
  // some endpoints return English POS labels
  noun: '名', verb: '動', adjective: '形', adverb: '副', numeral: '数', pronoun: '代',
  determiner: '冠', interjection: '感', conjunction: '副', particle: '助', phrase: '句',
};
const posAbbr = (p) => POS_ABBR[String(p || '').trim()] || POS_ABBR[String(p || '').toLowerCase()] || (p || '');

// ---- 1) built-in decks as a local dictionary ----
let _localMap = null;
async function localLookup(term) {
  try {
    let map = _localMap;
    if (!map) {
      const idx = await loadIndex();
      const decks = await Promise.all(idx.map((d) => loadDeck(d.id).catch(() => null)));
      map = new Map();
      for (const deck of decks) {
        for (const w of (deck && deck.words) || []) {
          const k = (w.t || '').trim();
          if (k && !map.has(k)) map.set(k, w);
        }
      }
      // only cache once every deck loaded, so a failed one gets retried
      if (decks.every(Boolean)) _localMap = map;
    }
    return map.get(term.trim()) || null;
  } catch { return null; }
}

// ---- 2) Google (gtx), ko -> ja ----
const GTX = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=ko&tl=ja';
async function gtxWord(term) {
  const d = await jget(`${GTX}&dt=t&dt=bd&q=${encodeURIComponent(term)}`);
  if (!Array.isArray(d)) return null;
  let main = ((d[0] || []).map((s) => s && s[0]).filter(Boolean).join('') || '').trim();
  if (main === term) main = ''; // untranslated echo = no result
  const senses = [];
  for (const grp of d[1] || []) {
    const pos = posAbbr(grp[0]);
    const detailed = (grp[2] || [])
      .map((e) => ({ gloss: e && e[0], score: (e && e[3]) || 0 }))
      .filter((e) => e.gloss)
      .sort((a, b) => b.score - a.score)
      .map((e) => e.gloss);
    const glosses = (detailed.length ? detailed : (grp[1] || [])).slice(0, 4);
    if (glosses.length) senses.push({ pos, glosses });
  }
  if (!main && !senses.length) return null;
  return { main, senses };
}
async function gtxSentence(text) { // sentence
  if (!text) return '';
  const d = await jget(`${GTX}&dt=t&q=${encodeURIComponent(text)}`);
  if (!Array.isArray(d)) return '';
  const t = ((d[0] || []).map((s) => s && s[0]).filter(Boolean).join('') || '').trim();
  return t === text ? '' : t;
}

// ---- 3) MyMemory (fallback) ----
async function translateKoToJa(text) {
  if (!text) return '';
  const d = await jget(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=ko|ja`);
  const t = d && d.responseData && d.responseData.translatedText;
  if (!t || /MYMEMORY WARNING|INVALID/i.test(t)) return '';
  return t.trim();
}

export async function lookup(term) {
  term = (term || '').trim();
  const out = {
    term, meaning: '', reading: '', pos: '', example: '', exampleJa: '',
    audioUrl: '', image: '', candidates: [],
  };
  if (!term) return out;

  // reading works offline
  out.reading = toKatakana(term);

  // run the lookups in parallel
  const [local, g] = await Promise.all([localLookup(term), gtxWord(term)]);

  // candidates: deck gloss first, then Google senses
  const seen = new Set();
  const addCand = (pos, gloss, src) => {
    const gg = (gloss || '').trim();
    const k = gg.replace(/\s+/g, '');
    if (!gg || seen.has(k)) return;
    seen.add(k);
    out.candidates.push({ pos: pos || '', gloss: gg, src });
  };
  if (local) for (const gl of String(local.m).split(/[,、]/)) addCand(local.p, gl.trim(), 'deck');
  if (g) {
    if (g.main) addCand(g.senses[0]?.pos || '', g.main, 'g');
    for (const s of g.senses) for (const gl of s.glosses) addCand(s.pos, gl, 'g');
  }
  out.candidates = out.candidates.slice(0, 12);

  // meaning: deck > Google > MyMemory
  if (local) {
    out.meaning = local.m;
  } else if (g) {
    const first = (g.senses[0] && g.senses[0].glosses) || [];
    out.meaning = [...new Set([g.main, ...first].filter(Boolean))].slice(0, 3).join('、');
  } else {
    out.meaning = await translateKoToJa(term);
  }

  out.pos = (local && local.p) || (g && g.senses[0] && g.senses[0].pos) || '';

  // examples only come from the decks (no good free source otherwise)
  if (local && local.ex) { out.example = local.ex; out.exampleJa = local.exk || ''; }
  if (out.example && !out.exampleJa) {
    out.exampleJa = (await gtxSentence(out.example)) || (await translateKoToJa(out.example));
  }

  return out;
}

// bulk lookup, paced for the free APIs. opts.stopped() aborts; errors go to opts.onError
export async function lookupMany(terms, onEach, opts = {}) {
  const results = [];
  for (let i = 0; i < terms.length; i++) {
    if (opts.stopped && opts.stopped()) break;
    const r = await lookup(terms[i]);
    results.push(r);
    if (onEach) {
      try { await onEach(r, i, terms.length); }
      catch (err) { if (opts.onError) opts.onError(err, terms[i]); }
    }
    await new Promise((res) => setTimeout(res, 350));
  }
  return results;
}
