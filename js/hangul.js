// Hangul -> katakana reading (안녕하세요 -> アンニョンハセヨ).
// Only the main rules (voicing of ㄱ/ㄷ/ㅂ/ㅈ, batchim, liaison), so it's approximate:
// 합니다 comes out as ハプニダ, not ハムニダ.

const SBASE = 0xac00, SLAST = 0xd7a3;

// medial vowel index (0..20) → vowel sound key
const VOWEL = [
  'a',  // ㅏ
  'e',  // ㅐ (ae)
  'ya', // ㅑ
  'ye', // ㅒ (yae)
  'o',  // ㅓ (eo)
  'e',  // ㅔ
  'yo', // ㅕ (yeo)
  'ye', // ㅖ
  'o',  // ㅗ
  'wa', // ㅘ
  'we', // ㅙ (wae)
  'we', // ㅚ (oe)
  'yo', // ㅛ
  'u',  // ㅜ
  'wo', // ㅝ
  'we', // ㅞ
  'wi', // ㅟ
  'yu', // ㅠ
  'u',  // ㅡ (eu)
  'wi', // ㅢ (ui)
  'i',  // ㅣ
];

// initial consonant index (0..18) → { base, voiced? }
// voiced is used when the syllable is word-medial and follows a vowel or a sonorant coda.
const INIT = [
  { base: 'k', voiced: 'g' }, // ㄱ
  { base: 'k' },              // ㄲ
  { base: 'n' },              // ㄴ
  { base: 't', voiced: 'd' }, // ㄷ
  { base: 't' },              // ㄸ
  { base: 'r' },              // ㄹ
  { base: 'm' },              // ㅁ
  { base: 'p', voiced: 'b' }, // ㅂ
  { base: 'p' },              // ㅃ
  { base: 's' },              // ㅅ
  { base: 's' },              // ㅆ
  { base: '' },               // ㅇ (silent)
  { base: 'ch', voiced: 'j' },// ㅈ
  { base: 'ch' },             // ㅉ
  { base: 'ch' },             // ㅊ
  { base: 'k' },              // ㅋ
  { base: 't' },              // ㅌ
  { base: 'p' },              // ㅍ
  { base: 'h' },              // ㅎ
];

// 5 base-vowel kana [a, i, u, e, o] per consonant family. Glides are composed from these.
const BASE = {
  k:  { a: 'カ', i: 'キ', u: 'ク', e: 'ケ', o: 'コ' },
  g:  { a: 'ガ', i: 'ギ', u: 'グ', e: 'ゲ', o: 'ゴ' },
  n:  { a: 'ナ', i: 'ニ', u: 'ヌ', e: 'ネ', o: 'ノ' },
  t:  { a: 'タ', i: 'ティ', u: 'トゥ', e: 'テ', o: 'ト' },
  d:  { a: 'ダ', i: 'ディ', u: 'ドゥ', e: 'デ', o: 'ド' },
  r:  { a: 'ラ', i: 'リ', u: 'ル', e: 'レ', o: 'ロ' },
  m:  { a: 'マ', i: 'ミ', u: 'ム', e: 'メ', o: 'モ' },
  p:  { a: 'パ', i: 'ピ', u: 'プ', e: 'ペ', o: 'ポ' },
  b:  { a: 'バ', i: 'ビ', u: 'ブ', e: 'ベ', o: 'ボ' },
  s:  { a: 'サ', i: 'シ', u: 'ス', e: 'セ', o: 'ソ' },
  ch: { a: 'チャ', i: 'チ', u: 'チュ', e: 'チェ', o: 'チョ' },
  j:  { a: 'ジャ', i: 'ジ', u: 'ジュ', e: 'ジェ', o: 'ジョ' },
  h:  { a: 'ハ', i: 'ヒ', u: 'フ', e: 'ヘ', o: 'ホ' },
};

// vowel-initial (ㅇ) syllables: full table incl. y/w glides
const SILENT = {
  a: 'ア', i: 'イ', u: 'ウ', e: 'エ', o: 'オ',
  ya: 'ヤ', yu: 'ユ', yo: 'ヨ', ye: 'イェ',
  wa: 'ワ', wo: 'ウォ', we: 'ウェ', wi: 'ウィ',
};

// final consonant index (0..27) → coda kana
const FINAL = [
  '',   // 0 none
  'ク', // ㄱ
  'ク', // ㄲ
  'ク', // ㄳ
  'ン', // ㄴ
  'ン', // ㄵ
  'ン', // ㄶ
  'ッ', // ㄷ
  'ル', // ㄹ
  'ク', // ㄺ
  'ム', // ㄻ
  'ル', // ㄼ
  'ル', // ㄽ
  'ル', // ㄾ
  'プ', // ㄿ
  'ル', // ㅀ
  'ム', // ㅁ
  'プ', // ㅂ
  'プ', // ㅄ
  'ッ', // ㅅ
  'ッ', // ㅆ
  'ン', // ㅇ (ng)
  'ッ', // ㅈ
  'ッ', // ㅊ
  'ク', // ㅋ
  'ッ', // ㅌ
  'プ', // ㅍ
  'ッ', // ㅎ
];

// sonorant codas (incl. none) after which a following ㄱ/ㄷ/ㅂ/ㅈ voices
const SONORANT_FINAL = new Set([0, 4, 5, 6, 8, 16, 21]);

const SMALL_Y = { ya: 'ャ', yu: 'ュ', yo: 'ョ', ye: 'ェ' };
const SMALL_W = { wa: 'ァ', wo: 'ォ', we: 'ェ', wi: 'ィ' };

// 연음: a final consonant moves onto a following ㅇ syllable (직업 -> 지겁, 좋아 -> 조아)
// { keep: remaining final, ini: moved initial, or null if it drops }. ㅇ (21) never moves.
const LIAISON = {
  1: { keep: 0, ini: 0 }, 2: { keep: 0, ini: 1 }, 3: { keep: 1, ini: 9 },
  4: { keep: 0, ini: 2 }, 5: { keep: 4, ini: 12 }, 6: { keep: 0, ini: 2 },
  7: { keep: 0, ini: 3 }, 8: { keep: 0, ini: 5 }, 9: { keep: 8, ini: 0 },
  10: { keep: 8, ini: 6 }, 11: { keep: 8, ini: 7 }, 12: { keep: 8, ini: 9 },
  13: { keep: 8, ini: 16 }, 14: { keep: 8, ini: 17 }, 15: { keep: 0, ini: 5 },
  16: { keep: 0, ini: 6 }, 17: { keep: 0, ini: 7 }, 18: { keep: 17, ini: 9 },
  19: { keep: 0, ini: 9 }, 20: { keep: 0, ini: 10 }, 22: { keep: 0, ini: 12 },
  23: { keep: 0, ini: 14 }, 24: { keep: 0, ini: 15 }, 25: { keep: 0, ini: 16 },
  26: { keep: 0, ini: 17 }, 27: { keep: 0, ini: null },
};

function compose(b, v) {
  if (v === 'a' || v === 'i' || v === 'u' || v === 'e' || v === 'o') return b[v];
  if (SMALL_Y[v]) return b.i + SMALL_Y[v];
  if (SMALL_W[v]) return b.u + SMALL_W[v];
  return b.a;
}

function syllable(ini, med, fin, wordInitial, prevFinal) {
  const vKey = VOWEL[med];
  const cls = INIT[ini];
  let name = cls.base;
  if (cls.voiced && !wordInitial && SONORANT_FINAL.has(prevFinal)) name = cls.voiced;
  const kana = name === '' ? SILENT[vKey] : compose(BASE[name], vKey);
  return (kana || '') + FINAL[fin];
}

// Convert a Korean string to a katakana reading. Non-Hangul characters pass through.
export function toKatakana(str) {
  // 1) tokenize into Hangul syllables {h:true, ini,med,fin} and literals {h:false, ch}
  const toks = [];
  for (const ch of String(str || '')) {
    const code = ch.codePointAt(0);
    if (code >= SBASE && code <= SLAST) {
      const idx = code - SBASE;
      toks.push({ h: true, ini: Math.floor(idx / (21 * 28)), med: Math.floor(idx / 28) % 21, fin: idx % 28 });
    } else {
      toks.push({ h: false, ch });
    }
  }
  // 2) apply liaison between adjacent Hangul syllables
  for (let i = 0; i < toks.length - 1; i++) {
    const a = toks[i], b = toks[i + 1];
    if (!a.h || !b.h || b.ini !== 11) continue; // next must start with ㅇ
    const mv = LIAISON[a.fin];
    if (!mv) continue;
    a.fin = mv.keep;
    if (mv.ini != null) b.ini = mv.ini;
  }
  // 3) render, tracking word boundaries for the voicing rule
  let out = '';
  let prevHangul = false;
  let prevFinal = 0;
  for (const t of toks) {
    if (t.h) {
      out += syllable(t.ini, t.med, t.fin, !prevHangul, prevFinal);
      prevHangul = true;
      prevFinal = t.fin;
    } else {
      out += t.ch;
      prevHangul = false;
      prevFinal = 0;
    }
  }
  return out;
}

export const isHangul = (s) => /[가-힣]/.test(String(s || ''));
