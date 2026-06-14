// word fields: term (Korean), reading (katakana), meaning (Japanese), example (Korean), exampleJa (Japanese)
import * as db from './db.js';
import * as dict from './dict.js';
import * as decklib from './decklib.js';
import * as syncer from './sync.js';
import { pronounce, speak, stop as stopAudio } from './tts.js';
import * as speech from './speech.js';
import { schedule, previewIntervals, Rating, State } from './fsrs.js';
import { HandwritingPad } from './handwriting.js';
import { toKatakana } from './hangul.js';

const DAY = 86400000;
const DEFAULT_SETTINGS = {
  newWordsPerDay: 15,
  requestRetention: 0.90,
  maximumInterval: 365 * 5,
  leechLapses: 4,
  productiveInput: 'handwrite', // 'handwrite' | 'type'
  repeatWrites: 3,
  backlogThrottle: 150,
  autoFetch: true,
  theme: 'auto', // 'auto' | 'dark' | 'light'
};

const THEME_COLORS = { dark: '#0b1018', light: '#eef1f9' };
function applyTheme() {
  const t = settings.theme === 'dark' || settings.theme === 'light' ? settings.theme : '';
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  // mirror to localStorage so the next cold start can theme before IndexedDB opens
  try { localStorage.setItem('kokuin-theme', t || 'auto'); } catch { /* private mode */ }
  const effective = t || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.content = THEME_COLORS[effective]; });
}
// apply the saved theme before settings load (avoids a flash)
try {
  const t = localStorage.getItem('kokuin-theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
} catch { /* private mode */ }

const DIR = {
  recall: { key: 'recall', label: '意味を思い出す', from: 'ko' },  // KO -> JA (receptive)
  produce: { key: 'produce', label: '韓国語で書く', from: 'ja' },  // JA -> KO (productive)
};

let settings = { ...DEFAULT_SETTINGS };
let session = null;
let pad = null;
let bulkRun = null; // running 一括追加 (setView sets .stop)

// ---------- utilities ----------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (id) => document.getElementById(id);
const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxxyxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayNum = (t) => Math.floor(t / DAY);

// keep Hangul and alphanumerics only (spacing varies)
function normalize(s) {
  return String(s || '').trim().toLowerCase().normalize('NFC').replace(/[^0-9a-z가-힣]/g, '');
}
function levenshtein(a, b) {
  a = normalize(a); b = normalize(b);
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[m][n];
}
function scoreTyped(answer, target) {
  const a = normalize(answer), t = normalize(target);
  if (!a) return 'wrong';
  if (a === t) return 'correct';
  if (t.length > 3 && levenshtein(a, t) <= 1) return 'almost';
  return 'wrong';
}
// use the given reading, otherwise generate one from the Hangul
const readingFor = (term, given) => (given && String(given).trim()) ? String(given).trim() : toKatakana(term);

function fmtInterval(days) {
  if (days <= 0) return '5分';
  if (days < 30) return `${days}日`;
  if (days < 365) return `${Math.round(days / 30)}ヶ月`;
  return `${(days / 365).toFixed(days < 730 ? 1 : 0)}年`;
}
function dueLabel(card, now = Date.now()) {
  if (card.state === State.New) return '新出単語';
  const d = Math.round((card.due - now) / DAY);
  if (card.due <= now) return '復習予定';
  return `${d}日後`;
}
let toastT;
function toast(msg) {
  let t = el('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200);
}
function hideToast() {
  const t = el('toast');
  if (t) { clearTimeout(toastT); t.classList.remove('show'); }
}

// small inline SVG icons
const IC = {
  speaker: '<svg class="ic" viewBox="0 0 24 24"><path d="M11 5 6.5 9H3v6h3.5L11 19zM15.5 8.5a5 5 0 0 1 0 7M18.2 6a8.5 8.5 0 0 1 0 12"/></svg>',
  flame: '<svg class="ic" viewBox="0 0 24 24"><path d="M12 3s5.5 4.2 5.5 9.2A5.5 5.5 0 0 1 12 17.7a5.5 5.5 0 0 1-5.5-5.5c0-2.3 1.2-4.1 2.5-5.7.6 1 1.5 1.7 2.5 1.7C11.5 6.5 12 3 12 3z"/></svg>',
  clipboard: '<svg class="ic" viewBox="0 0 24 24"><rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9 5V3h6v2M9.5 11h5M9.5 15h5"/></svg>',
  drop: '<svg class="ic" viewBox="0 0 24 24"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/></svg>',
  mic: '<svg class="ic" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  play: '<svg class="ic" viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>',
};

// ---------- settings / counters / streak ----------
async function loadSettings() { settings = { ...DEFAULT_SETTINGS, ...(await db.getMeta('settings', {})) }; }
async function saveSettings() { await db.setMeta('settings', settings); }
async function getCounters() { return (await db.getMeta('counters', {})) || {}; }
async function bumpCounter(field, by = 1) {
  const c = await getCounters(); const k = todayKey();
  c[k] = c[k] || { newWords: 0, reviews: 0 };
  c[k][field] = (c[k][field] || 0) + by;
  await db.setMeta('counters', c); return c[k];
}
async function bumpStreak() {
  const s = (await db.getMeta('streak', { current: 0, longest: 0, last: null })) || {};
  const today = dayNum(Date.now());
  if (s.last === today) return s;
  const gap = s.last == null ? Infinity : today - s.last;
  if (gap <= 2) s.current = (s.current || 0) + 1; // allow one missed day
  else s.current = 1;
  s.longest = Math.max(s.longest || 0, s.current);
  s.last = today;
  await db.setMeta('streak', s); return s;
}

// ---------- sync ----------
// sync passphrase and auto flag stay in localStorage (per device, not in backups)
function getSyncPass() { try { return localStorage.getItem('kokuin-sync-pass') || ''; } catch { return ''; } }
function setSyncPass(v) { try { localStorage.setItem('kokuin-sync-pass', v); } catch { /* private mode */ } }
function getSyncAuto() { try { return localStorage.getItem('kokuin-sync-auto') === '1'; } catch { return false; } }
function setSyncAuto(v) { try { localStorage.setItem('kokuin-sync-auto', v ? '1' : '0'); } catch { /* private mode */ } }

let syncing = false;
let syncPending = false; // a sync was requested while one was already running
async function runSync(manual = false) {
  const pass = getSyncPass();
  if (!pass) { if (manual) toast('先に同期パスワードを入力してください'); return; }
  if (pass.length < 8) { if (manual) toast('同期パスワードは8文字以上にしてください'); return; }
  // don't merge during a review (auto sync waits, manual sync shows a message)
  if (session) {
    if (manual) toast('復習が終わったら同期します');
    else syncPending = true;
    return;
  }
  if (syncing) { syncPending = true; return; }
  syncing = true;
  const st = el('sync-status');
  if (st && document.contains(st)) st.textContent = '同期中…';
  const opts = {};
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await syncer.sync(pass, opts);
        try { localStorage.setItem('kokuin-sync-last', String(Date.now())); } catch { /* ok */ }
        const msg = `同期完了 — 全${r.words}語${r.pulledWords > 0 ? ` (+${r.pulledWords} 受信)` : ''}`;
        if (st && document.contains(st)) st.textContent = `${msg} · ${new Date().toLocaleTimeString('ja-JP')}`;
        if (manual) toast(msg);
        if (currentView === 'home' && !session) renderHome(); // pulled words change today's queue
        break;
      } catch (e) {
        const code = e && e.code;
        if (manual && code === 'decrypt' && !opts.forceReset
          && confirm('サーバーに保存されたデータを復号できません(別のパスワードで保存したか、破損)。この端末のデータでサーバーを上書きしますか？')) {
          opts.forceReset = true; continue;
        }
        if (manual && code === 'destroy' && !opts.allowDestroy
          && confirm(e.message + '\n続行するとこの端末でも削除されます。進めますか？')) {
          opts.allowDestroy = true; continue;
        }
        const msg = navigator.onLine === false ? 'オフライン — オンラインになったら再試行してください' : (e && e.message) || '同期失敗';
        if (st && document.contains(st)) st.textContent = '失敗: ' + msg;
        if (manual) toast('同期失敗: ' + msg);
        break;
      }
    }
  } finally {
    syncing = false;
    if (syncPending) { syncPending = false; setTimeout(() => runSync(false), 0); }
  }
}
function autoSync() { if (getSyncAuto() && getSyncPass()) runSync(false); }
let syncDebounce;
function autoSyncSoon() { // debounced
  if (!getSyncAuto() || !getSyncPass()) return;
  clearTimeout(syncDebounce);
  syncDebounce = setTimeout(() => runSync(false), 4000);
}

// ---------- data ops ----------
async function addWord(fields) {
  const now = Date.now();
  const id = uid();
  const term = (fields.term || '').trim();
  const word = {
    id, term, meaning: fields.meaning || '', reading: readingFor(term, fields.reading),
    pos: fields.pos || '', example: fields.example || '', exampleJa: fields.exampleJa || '',
    audioUrl: fields.audioUrl || '', image: fields.image || '', note: fields.note || '',
    deck: fields.deck || '基本', createdAt: now, updatedAt: now,
  };
  await db.put('words', word);
  for (const dir of ['recall', 'produce']) {
    await db.put('cards', {
      id: uid(), wordId: id, direction: dir, deck: word.deck,
      state: State.New, stability: null, difficulty: null, due: now,
      reps: 0, lapses: 0, lastReview: null, leech: false, suspended: false, createdAt: now,
    });
  }
  return word;
}
// bulk add from a built-in deck, in one transaction
// createdAt = now + i keeps the deck order for new cards
async function bulkAddWords(entries, deckName) {
  const base = Date.now();
  const words = [], cards = [];
  entries.forEach((e, i) => {
    const id = uid();
    const createdAt = base + i;
    const term = (e.term || '').trim();
    words.push({
      id, term, meaning: e.meaning || '', reading: readingFor(term, e.reading),
      pos: e.pos || '', example: e.example || '', exampleJa: e.exampleJa || '',
      audioUrl: '', image: '', note: '', deck: deckName, createdAt, updatedAt: createdAt,
    });
    for (const dir of ['recall', 'produce']) {
      cards.push({
        id: uid(), wordId: id, direction: dir, deck: deckName,
        state: State.New, stability: null, difficulty: null, due: createdAt,
        reps: 0, lapses: 0, lastReview: null, leech: false, suspended: false, createdAt,
      });
    }
  });
  await db.bulkPutAll({ words, cards }); // atomic: no orphan words if the page dies mid-import
  return words.length;
}
async function deleteWord(id) {
  await db.del('words', id);
  const cards = await db.allByIndex('cards', 'wordId', id);
  for (const c of cards) await db.del('cards', c.id);
  // tombstone so the delete syncs to other devices
  const t = (await db.getMeta('tombstones', {})) || {};
  t[id] = Date.now();
  await db.setMeta('tombstones', t);
}
async function getDecks() {
  const words = await db.all('words');
  return [...new Set(words.map((w) => w.deck || '基本'))].sort();
}

// ---------- queue ----------
async function buildQueue(deck) {
  const now = Date.now();
  const cards = (await db.all('cards')).filter((c) => !c.suspended && (deck && deck !== '全体' ? c.deck === deck : true));
  const words = Object.fromEntries((await db.all('words')).map((w) => [w.id, w]));

  let dueCards = cards.filter((c) => c.state !== State.New && c.due <= now).sort((a, b) => a.due - b.due);

  const counters = await getCounters();
  const introduced = (counters[todayKey()]?.newWords) || 0;
  let allowance = Math.max(0, settings.newWordsPerDay - introduced);
  let throttled = false;
  if (dueCards.length > settings.backlogThrottle) { allowance = 0; throttled = true; }

  // new words (both cards), oldest first
  const newByWord = new Map();
  for (const c of cards.filter((x) => x.state === State.New)) {
    if (!newByWord.has(c.wordId)) newByWord.set(c.wordId, []);
    newByWord.get(c.wordId).push(c);
  }
  const newWordIds = [...newByWord.keys()].filter((id) => words[id]).sort((a, b) => words[a].createdAt - words[b].createdAt).slice(0, allowance);
  const dirOrder = { recall: 0, produce: 1 }; // recall before produce
  const newCards = [];
  for (const id of newWordIds) {
    const cs = newByWord.get(id).slice().sort((a, b) => (dirOrder[a.direction] ?? 9) - (dirOrder[b.direction] ?? 9));
    for (const c of cs) newCards.push(c);
  }

  const queue = [...dueCards, ...newCards].map((c) => ({ card: c, word: words[c.wordId] })).filter((x) => x.word);
  return { queue, throttled, dueCount: dueCards.length, newCount: newWordIds.length };
}

// ---------- review session ----------
async function startReview(deck) {
  const { queue, throttled } = await buildQueue(deck);
  if (!queue.length) { toast(throttled ? '復習がたまっています — 新出単語はいったん停止' : '今復習するカードはありません'); return; }
  session = { queue, idx: 0, deck, reviewed: 0, correct: 0, phase: 'attempt', revealed: false, lastScore: null, writesDone: 0 };
  setView('review');
  renderCard();
}

function currentItem() { return session.queue[session.idx]; }

// ---------- 復習モード (cram, doesn't touch FSRS) ----------
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
async function cramFromWords(wordList, dir = 'both') {
  if (!wordList.length) { toast('条件に合う単語がありません'); return; }
  const wordIds = new Set(wordList.map((w) => w.id));
  const wmap = Object.fromEntries(wordList.map((w) => [w.id, w]));
  const cards = (await db.all('cards')).filter((c) => wordIds.has(c.wordId) && !c.suspended && (dir === 'both' || c.direction === dir));
  if (!cards.length) { toast('テストするカードがありません'); return; }
  // all recall cards first, then produce, so a word's two cards are far apart
  const recall = shuffle(cards.filter((c) => c.direction === 'recall'));
  const produce = shuffle(cards.filter((c) => c.direction === 'produce'));
  const queue = [...recall, ...produce].map((c) => ({ card: c, word: wmap[c.wordId] })).filter((x) => x.word);
  session = {
    mode: 'cram', dir, queue, idx: 0, deck: '全体', reviewed: 0, correct: 0,
    phase: 'attempt', revealed: false, lastScore: null, writesDone: 0,
    firstTry: new Map(), missed: new Map(),
  };
  setView('review');
  renderCard();
}
// used by 復習モード and 練習モード
async function wordsForScope(scope, deck) {
  const now = Date.now();
  return (await db.all('words')).filter((w) => {
    if (deck && deck !== '全体' && (w.deck || '基本') !== deck) return false;
    if (scope === 'today') return todayKey(w.createdAt) === todayKey(now);
    if (scope === 'week') return now - w.createdAt <= 7 * DAY;
    return true;
  });
}
async function startCram({ scope, deck, dir }) {
  await cramFromWords(await wordsForScope(scope, deck), dir);
}
function cramGrade(correct) {
  const { card, word } = currentItem();
  if (!session.firstTry.has(card.id)) {
    session.firstTry.set(card.id, correct);
    session.reviewed++;
    if (correct) session.correct++;
  }
  if (!correct) {
    session.missed.set(word.id, word);
    session.queue.push({ card, word }); // 正解するまでもう一度
  }
  session.idx++;
  session.phase = 'attempt'; session.revealed = false; session.lastScore = null; session.writesDone = 0; pad = null;
  if (session.idx >= session.queue.length) return finishCram();
  renderCard();
}
function finishCram() {
  const total = session.firstTry.size;
  const firstCorrect = [...session.firstTry.values()].filter(Boolean).length;
  const pct = total ? Math.round((firstCorrect / total) * 100) : 0;
  const missed = [...session.missed.values()];
  el('app').innerHTML = `
    <div class="done card">
      <div class="big-emoji">📋</div>
      <h2>復習モード完了</h2>
      <p class="muted">${total}枚 · 一発正解 ${firstCorrect}枚 (${pct}%)</p>
      ${missed.length ? `<div class="missed">
        <h3>間違えた単語 ${missed.length}個</h3>
        <ul class="word-list">${missed.map((w) => `<li><div class="b-main"><b>${esc(w.term)}</b><span class="b-mean">${esc(w.meaning)}</span></div></li>`).join('')}</ul>
        <button class="btn primary big" id="cram-again">間違えた単語だけもう一度</button>
      </div>` : `<p class="hint">全部正解しました！👏</p>`}
      <p class="hint">復習モードは復習スケジュール(FSRS)には反映されません。長期記憶は毎日の復習で作られます。</p>
      <button class="btn big" id="done-home">ホームへ</button>
    </div>`;
  const dir = session.dir;
  session = null;
  renderTabbar();
  autoSync(); // run the sync that was deferred during the session
  if (el('cram-again')) el('cram-again').onclick = () => cramFromWords(missed, dir);
  el('done-home').onclick = () => setView('home');
}

// ---------- 発音・リスニング練習 (shadowing / dictation / speaking) ----------
// speech recognition is optional, falls back to self-grading
const DRILL_LABEL = { shadow: 'シャドーイング', dictation: 'ディクテーション', speak: 'スピーキング' };

function practiceFromWords(words, drill) {
  if (!words.length) { toast('条件に合う単語がありません'); return; }
  session = {
    mode: 'practice', drill, queue: shuffle(words.slice()).map((w) => ({ word: w })),
    idx: 0, reviewed: 0, correct: 0, revealed: false, lastScore: null,
    heard: '', autoGraded: false, micError: '', listening: false, micJob: null, missed: new Map(),
  };
  setView('review');
  renderCard();
}
async function startPractice({ scope, deck, drill }) {
  practiceFromWords(await wordsForScope(scope, deck), drill);
}
function scoreSpeech(alts, term) {
  const t = normalize(term);
  for (const a of alts) { const n = normalize(a); if (n === t || n.split(' ').includes(t)) return 'correct'; }
  if (t.length > 3) for (const a of alts) { if (levenshtein(a, term) <= 1) return 'almost'; }
  return 'wrong';
}
function practiceAdvance(correct) {
  if (session.micJob) { try { session.micJob.cancel(); } catch { /* ignore */ } session.micJob = null; }
  if (correct !== null) {
    session.reviewed++;
    if (correct) session.correct++;
    else session.missed.set(currentItem().word.id, currentItem().word);
  }
  session.idx++;
  session.revealed = false; session.lastScore = null; session.heard = '';
  session.autoGraded = false; session.micError = ''; session.listening = false;
  if (session.idx >= session.queue.length) return finishPractice();
  renderCard();
}
function bindSay(id, w) { const b = el(id); if (b) b.onclick = () => pronounce(w.term, w.audioUrl); }
function practiceAnswerHTML(w) {
  return `
    <div class="answer big-term">${esc(w.term)} <button class="icon-btn" id="p-say" aria-label="発音を聞く">${IC.speaker}</button></div>
    ${w.reading ? `<div class="ipa">${esc(w.reading)}</div>` : ''}
    <div class="prompt-meaning sm">${esc(w.meaning) || '<span class="muted">意味 未入力</span>'}</div>
    ${w.example ? `<div class="example">“${esc(w.example)}”${w.exampleJa ? `<br><span class="muted">${esc(w.exampleJa)}</span>` : ''}</div>` : ''}`;
}
function bindExit() { if (el('rev-exit')) el('rev-exit').onclick = () => setView('home'); }

function renderPractice() {
  const item = currentItem();
  if (!item) return finishPractice();
  const { word } = item;
  if (session.drill === 'shadow') return renderShadow(word);
  if (session.drill === 'dictation') return renderDictation(word);
  return renderSpeak(word);
}

function renderShadow(word) {
  el('app').innerHTML = `${progressHTML()}
    <div class="card review">
      <div class="badges"><span class="badge practice">シャドーイング</span></div>
      <p class="hint">聞いたあと、<b>声に出して同じように繰り返して</b>みましょう。発音とリズムが口になじみます。</p>
      ${practiceAnswerHTML(word)}
      <div class="pad-tools center">
        <button class="btn" id="p-listen">${IC.play} ${word.example ? '文を聞く' : '単語を聞く'}</button>
        <button class="btn" id="p-slow">🐢 ゆっくり</button>
      </div>
      <div class="grade-wrap"><button class="btn primary big" id="p-next">次へ</button></div>
    </div>`;
  bindSay('p-say', word);
  el('p-listen').onclick = () => (word.example ? speak(word.example) : pronounce(word.term, word.audioUrl));
  el('p-slow').onclick = () => speak(word.example || word.term, 'ko-KR', 0.6);
  el('p-next').onclick = () => practiceAdvance(null);
  bindExit();
}

function renderDictation(word) {
  if (!session.revealed) {
    el('app').innerHTML = `${progressHTML()}
      <div class="card review">
        <div class="badges"><span class="badge practice">ディクテーション</span></div>
        <p class="hint">よく聞いて、聞こえた韓国語(ハングル)を書いてください。</p>
        <button class="btn primary big" id="p-listen">${IC.play} 聞く</button>
        <div class="pad-tools center"><button class="btn" id="p-slow">🐢 ゆっくり</button></div>
        <input id="p-ans" class="ans-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" lang="ko" placeholder="聞こえた単語を入力">
        <div class="row act-row">
          <button class="btn ghost" id="p-dont">わからない</button>
          <button class="btn primary" id="p-check">確認</button>
        </div>
      </div>`;
    const play = () => pronounce(word.term, word.audioUrl);
    el('p-listen').onclick = play;
    el('p-slow').onclick = () => speak(word.term, 'ko-KR', 0.55);
    const inp = el('p-ans'); inp.focus();
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') el('p-check').click(); });
    el('p-dont').onclick = () => { session.heard = ''; session.lastScore = 'wrong'; session.revealed = true; renderDictation(word); };
    el('p-check').onclick = () => {
      session.heard = inp.value; session.lastScore = scoreTyped(inp.value, word.term);
      session.revealed = true; renderDictation(word);
    };
  } else {
    const sc = session.lastScore;
    const verdict = sc === 'correct' ? '<span class="verdict ok">正解 ✓</span>'
      : sc === 'almost' ? '<span class="verdict almost">惜しい (つづり確認)</span>'
        : '<span class="verdict no">残念 ✗</span>';
    el('app').innerHTML = `${progressHTML()}
      <div class="card review">
        <div class="badges"><span class="badge practice">ディクテーション</span></div>
        ${verdict}
        ${session.heard ? `<div class="your-ans">書いた内容: <b>${esc(session.heard)}</b></div>` : ''}
        ${practiceAnswerHTML(word)}
        <div class="grade-wrap"><button class="btn primary big" id="p-next">次へ</button></div>
      </div>`;
    bindSay('p-say', word);
    el('p-next').onclick = () => practiceAdvance(sc === 'correct' || sc === 'almost');
  }
  bindExit();
}

function renderSpeak(word) {
  const canMic = speech.recognitionAvailable;
  const cloze = word.exampleJa ? `<div class="example">“${esc(word.exampleJa)}”</div>` : '';
  if (!session.revealed && session.listening) {
    el('app').innerHTML = `${progressHTML()}
      <div class="card review">
        <div class="badges"><span class="badge practice">スピーキング</span></div>
        <div class="prompt-meaning">${esc(word.meaning) || '<span class="muted">意味 未入力</span>'}</div>
        ${cloze}
        <div class="grade-wrap">
          <button class="btn primary big" disabled>${IC.mic} 聞き取り中… 話してください</button>
          <button class="btn big" id="p-cancel">キャンセル</button>
        </div>
      </div>`;
    el('p-cancel').onclick = () => {
      session.listening = false;
      if (session.micJob) { try { session.micJob.cancel(); } catch { /* ignore */ } session.micJob = null; }
      renderSpeak(word);
    };
  } else if (!session.revealed) {
    el('app').innerHTML = `${progressHTML()}
      <div class="card review">
        <div class="badges"><span class="badge practice">スピーキング</span></div>
        <p class="hint">下の意味を見て、<b>韓国語で声に出して言って</b>みましょう。</p>
        <div class="prompt-meaning">${esc(word.meaning) || '<span class="muted">意味 未入力</span>'}</div>
        ${cloze}
        <div class="grade-wrap">
          ${canMic ? `<button class="btn primary big" id="p-mic">${IC.mic} スピーキング (自動採点)</button>` : `<p class="hint">この端末は音声の自動採点に対応していません。声に出して言ってから正解を確認し、自分で採点してください。</p>`}
          <button class="btn big" id="p-reveal">正解を見る</button>
        </div>
      </div>`;
    if (canMic) el('p-mic').onclick = () => {
      // iOS recognition can hang until the timeout; ignore results if we've moved on
      const sess = session, item = currentItem();
      const stale = () => sess !== session || currentItem() !== item;
      session.listening = true;
      const job = speech.listen('ko-KR');
      session.micJob = job;
      renderSpeak(word);
      job.promise.then((alts) => {
        if (stale() || !session.listening) return;
        session.listening = false; session.micJob = null;
        session.heard = alts[0] || ''; session.lastScore = scoreSpeech(alts, word.term);
        session.autoGraded = true; session.revealed = true; renderSpeak(word);
      }).catch((err) => {
        if (stale() || !session.listening) return;
        session.listening = false; session.micJob = null;
        if (err && err.message === 'aborted') { renderSpeak(word); return; }
        session.micError = err && err.message === 'no-speech' ? '音声を聞き取れませんでした' : '音声認識に失敗しました';
        session.autoGraded = false; session.revealed = true; renderSpeak(word);
      });
    };
    el('p-reveal').onclick = () => { session.autoGraded = false; session.lastScore = null; session.revealed = true; renderSpeak(word); };
  } else {
    const sc = session.lastScore;
    const verdict = !session.autoGraded ? ''
      : sc === 'correct' ? '<span class="verdict ok">正解 ✓</span>'
        : sc === 'almost' ? '<span class="verdict almost">惜しい</span>'
          : '<span class="verdict no">残念 ✗</span>';
    el('app').innerHTML = `${progressHTML()}
      <div class="card review">
        <div class="badges"><span class="badge practice">スピーキング</span></div>
        ${verdict}
        ${session.micError ? `<div class="your-ans muted">${esc(session.micError)}</div>` : ''}
        ${session.heard ? `<div class="your-ans">話した内容: <b>${esc(session.heard)}</b></div>` : ''}
        ${practiceAnswerHTML(word)}
        ${session.autoGraded
          ? `<div class="grade-wrap"><button class="btn primary big" id="p-next">次へ</button></div>`
          : `<div class="grade-wrap"><p class="hint">今声に出して言ったのは正解と同じでしたか？</p>
              <div class="grade-row cram">
                <button class="grade again" id="p-no">不正解</button>
                <button class="grade good" id="p-yes">正解</button>
              </div></div>`}
      </div>`;
    bindSay('p-say', word);
    if (session.autoGraded) el('p-next').onclick = () => practiceAdvance(sc === 'correct' || sc === 'almost');
    else { el('p-no').onclick = () => practiceAdvance(false); el('p-yes').onclick = () => practiceAdvance(true); }
  }
  bindExit();
}

function finishPractice() {
  const drill = session.drill;
  const graded = drill !== 'shadow';
  const total = session.reviewed;
  const correct = session.correct;
  const pct = total ? Math.round((correct / total) * 100) : 0;
  const missed = [...session.missed.values()];
  const doneCount = session.queue.length;
  el('app').innerHTML = `
    <div class="done card">
      <div class="big-emoji">🎧</div>
      <h2>練習完了</h2>
      ${graded
        ? `<p class="muted">${total}個 · 正解 ${correct}個 (${pct}%)</p>`
        : `<p class="muted">${doneCount}個の単語を聞いて繰り返しました</p>`}
      ${missed.length ? `<div class="missed">
        <h3>間違えた単語 ${missed.length}個</h3>
        <ul class="word-list">${missed.map((w) => `<li><div class="b-main"><b>${esc(w.term)}</b><span class="b-mean">${esc(w.meaning)}</span></div><button class="icon-btn say" data-id="${esc(w.id)}" aria-label="発音を聞く">${IC.play}</button></li>`).join('')}</ul>
        <button class="btn primary big" id="p-again">間違えた単語だけもう一度</button>
      </div>` : (graded ? '<p class="hint">全部正解しました！👏</p>' : '')}
      <p class="hint">練習は復習スケジュール(FSRS)には反映されません。口に出すほど会話が伸びます。</p>
      <button class="btn big" id="done-home">ホームへ</button>
    </div>`;
  const wmap = Object.fromEntries(missed.map((w) => [w.id, w]));
  document.querySelectorAll('.missed .say').forEach((b) => { b.onclick = () => { const w = wmap[b.dataset.id]; if (w) pronounce(w.term, w.audioUrl); }; });
  session = null;
  renderTabbar();
  autoSync(); // run the sync that was deferred during the session
  if (el('p-again')) el('p-again').onclick = () => practiceFromWords(missed, drill);
  el('done-home').onclick = () => setView('home');
}


async function grade(rating) {
  if (session.mode === 'cram') return cramGrade(rating >= Rating.Good);
  if (session.grading) return; // double-tap guard
  session.grading = true;
  const sess = session; // session can become null while awaiting
  const { card, word } = currentItem();
  const wasNew = card.state === State.New;
  const sib = await db.allByIndex('cards', 'wordId', word.id);
  const firstOfWord = wasNew && sib.every((c) => c.id === card.id || c.state === State.New);

  const s = schedule(card, rating, Date.now(), { requestRetention: settings.requestRetention, maximumInterval: settings.maximumInterval });
  Object.assign(card, { stability: s.stability, difficulty: s.difficulty, state: s.state, reps: s.reps, lapses: s.lapses, lastReview: s.lastReview, due: s.due });
  if (card.lapses >= settings.leechLapses) card.leech = true;
  await db.put('cards', card);
  await db.put('reviews', { cardId: card.id, wordId: word.id, direction: card.direction, rating, ts: Date.now(), correct: rating >= Rating.Good });

  await bumpCounter('reviews', 1);
  if (firstOfWord) await bumpCounter('newWords', 1);
  await bumpStreak();

  // grade is saved; stop here if the user left the review meanwhile
  if (sess !== session) return;

  session.reviewed++;
  if (rating >= Rating.Good) session.correct++;
  if (rating === Rating.Again) session.queue.push({ card, word }); // re-show this session

  session.idx++;
  session.phase = 'attempt'; session.revealed = false; session.lastScore = null; session.writesDone = 0; pad = null;
  session.grading = false;
  if (currentView !== 'review') return; // left the review
  if (session.idx >= session.queue.length) return finishReview();
  renderCard();
}

function finishReview() {
  const { reviewed, correct } = session;
  const pct = reviewed ? Math.round((correct / reviewed) * 100) : 0;
  el('app').innerHTML = `
    <div class="done card">
      <div class="big-emoji">✅</div>
      <h2>セッション完了</h2>
      <p class="muted">今回 ${reviewed}枚 · 想起成功 ${pct}%</p>
      <p class="hint">本当の定着は<b>数日にわたる分散想起</b>で起こります。また明日。</p>
      <button class="btn primary" id="done-home">ホームへ</button>
    </div>`;
  el('done-home').onclick = () => setView('home');
  session = null;
  renderTabbar();
  autoSync(); // push progress
}

// ---------- review rendering ----------
function ratingButtonsHTML(card, opts = {}) {
  const now = Date.now();
  const pv = previewIntervals(card, now, { requestRetention: settings.requestRetention, maximumInterval: settings.maximumInterval });
  const allow = opts.allow || [1, 2, 3, 4];
  const meta = {
    1: { t: 'もう一度', c: 'again' }, 2: { t: '難しい', c: 'hard' },
    3: { t: 'ちょうど', c: 'good' }, 4: { t: '簡単', c: 'easy' },
  };
  return `<div class="grade-row">${[1, 2, 3, 4].map((g) => {
    const dis = allow.includes(g) ? '' : 'disabled';
    return `<button class="grade ${meta[g].c}" data-grade="${g}" ${dis}>
      <span class="g-t">${meta[g].t}</span><span class="g-i">${fmtInterval(pv[g])}</span></button>`;
  }).join('')}</div>`;
}
// cram mode: just right/wrong, wrong cards come back until correct.
// opts.allow limits the buttons for typed answers, same as normal review
function gradeAreaHTML(card, opts = {}) {
  if (session.mode === 'cram') {
    const allow = opts.allow || [1, 3];
    return `<div class="grade-row cram">
      <button class="grade again" data-grade="1" ${allow.includes(1) ? '' : 'disabled'}><span class="g-t">不正解</span><span class="g-i">また出る</span></button>
      <button class="grade good" data-grade="3" ${allow.includes(3) ? '' : 'disabled'}><span class="g-t">正解</span><span class="g-i">通過</span></button>
    </div>`;
  }
  return ratingButtonsHTML(card, opts);
}
function cramBadge() { return session.mode === 'cram' ? '<span class="badge cram">復習</span>' : ''; }
function bindGrades() {
  document.querySelectorAll('.grade[data-grade]').forEach((b) => {
    b.onclick = () => grade(Number(b.dataset.grade));
  });
}
function audioBtnHTML() { return `<button class="icon-btn" id="say" aria-label="発音を聞く">${IC.speaker}</button>`; }
function bindAudio(word) { const b = el('say'); if (b) b.onclick = () => pronounce(word.term, word.audioUrl); }

function progressHTML() {
  const total = session.queue.length;
  // min 3% so the bar is never empty
  const pct = Math.min(100, Math.max(3, ((session.idx + 1) / total) * 100));
  return `<div class="rev-top">
    <button class="link rev-exit" id="rev-exit" aria-label="復習を終了">✕</button>
    <div class="rev-prog"><div style="width:${pct}%"></div></div>
    <span class="rev-count">${session.idx + 1}/${total}</span>
  </div>`;
}

function renderCard() {
  if (session.mode === 'practice') return renderPractice();
  const item = currentItem();
  if (!item) return session.mode === 'cram' ? finishCram() : finishReview();
  const { card, word } = item;
  if (card.direction === 'recall') return renderRecall(card, word);
  return renderProduce(card, word);
}

// KO -> JA: show the Korean word, recall the meaning
function renderRecall(card, word) {
  const newBadge = card.state === State.New ? `<span class="badge new">新出</span>` : '';
  const leech = card.leech ? `<span class="badge leech">${IC.drop} よく間違える</span>` : '';
  if (!session.revealed) {
    el('app').innerHTML = `${progressHTML()}
      <div class="card review">
        <div class="badges">${cramBadge()}${newBadge}${leech}<span class="badge dir">意味を思い出す</span></div>
        <div class="prompt-term">${esc(word.term)} ${audioBtnHTML()}</div>
        ${word.reading ? `<div class="ipa">${esc(word.reading)}</div>` : ''}
        <p class="hint">この単語の意味を思い出してみましょう。</p>
        <button class="btn primary big push-bottom" id="reveal">意味を見る</button>
      </div>`;
    bindAudio(word);
    el('reveal').onclick = () => { session.revealed = true; renderRecall(card, word); };
  } else {
    el('app').innerHTML = `${progressHTML()}
      <div class="card review">
        <div class="badges">${cramBadge()}${newBadge}${leech}<span class="badge dir">意味を思い出す</span></div>
        <div class="prompt-term sm">${esc(word.term)} ${audioBtnHTML()}</div>
        ${word.reading ? `<div class="ipa">${esc(word.reading)}</div>` : ''}
        <div class="answer">${esc(word.meaning) || '<span class="muted">意味 未入力</span>'}</div>
        ${word.example ? `<div class="example">“${esc(word.example)}”${word.exampleJa ? `<br><span class="muted">${esc(word.exampleJa)}</span>` : ''}</div>` : ''}
        <div class="grade-wrap">
          <p class="hint">どれくらい思い出せましたか？</p>
          ${gradeAreaHTML(card)}
        </div>
      </div>`;
    bindAudio(word); bindGrades();
  }
  el('rev-exit').onclick = () => setView('home');
}

// JA -> KO: write or type the Korean word
function renderProduce(card, word) {
  const mode = settings.productiveInput;
  const newBadge = card.state === State.New ? `<span class="badge new">新出</span>` : '';
  const leech = card.leech ? `<span class="badge leech">${IC.drop} よく間違える</span>` : '';
  const promptMeaning = esc(word.meaning) || '<span class="muted">意味 未入力</span>';
  // blank out the headword in the raw example, then escape. Inflected verbs won't
  // match the dictionary form, so they just get no cloze.
  let cloze = '';
  if (word.example && word.term) {
    const safeTerm = word.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const blanked = word.example.replace(new RegExp(safeTerm, 'g'), '\u0000');
    if (blanked.includes('\u0000')) cloze = esc(blanked).replace(/\u0000/g, '____');
  }

  if (!session.revealed) {
    const inputArea = mode === 'handwrite'
      ? `<canvas id="pad" class="pad"></canvas>
         <div class="pad-tools">
           <button class="chip" id="pad-undo">↶ 一画戻す</button>
           <button class="chip" id="pad-clear">消す</button>
         </div>`
      : `<input id="ans" class="ans-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="韓国語を入力" lang="ko">`;
    el('app').innerHTML = `${progressHTML()}
      <div class="card review">
        <div class="badges">${cramBadge()}${newBadge}${leech}<span class="badge dir">韓国語で書く</span></div>
        <div class="prompt-meaning">${promptMeaning}</div>
        ${cloze ? `<div class="example">“${cloze}”</div>` : ''}
        <p class="hint">${mode === 'handwrite' ? '記憶から韓国語(ハングル)を手で書いてみましょう。' : '記憶から韓国語(ハングル)を入力しましょう。'}</p>
        ${inputArea}
        <div class="row act-row">
          <button class="btn ghost" id="dont-know">わからない</button>
          <button class="btn primary" id="check">確認</button>
        </div>
      </div>`;
    if (mode === 'handwrite') {
      pad = new HandwritingPad(el('pad'));
      el('pad-undo').onclick = () => pad.undo();
      el('pad-clear').onclick = () => pad.clear();
    } else {
      const inp = el('ans'); inp.focus();
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') el('check').click(); });
    }
    el('dont-know').onclick = () => { session.lastScore = 'wrong'; session.typed = ''; session.revealed = true; renderProduce(card, word); };
    el('check').onclick = () => {
      if (mode === 'type') { session.typed = el('ans').value; session.lastScore = scoreTyped(session.typed, word.term); }
      else { session.typed = null; session.lastScore = pad && !pad.isEmpty() ? 'written' : 'wrong'; }
      session.revealed = true; renderProduce(card, word);
    };
  } else {
    renderProduceReveal(card, word, mode, cloze);
  }
  if (el('rev-exit')) el('rev-exit').onclick = () => setView('home');
}

function renderProduceReveal(card, word, mode, cloze) {
  const sc = session.lastScore;
  const verdict = sc === 'correct' ? `<span class="verdict ok">正解 ✓</span>`
    : sc === 'almost' ? `<span class="verdict almost">惜しい (つづり確認)</span>`
    : sc === 'written' ? `<span class="verdict neutral">自分で採点してください</span>`
    : `<span class="verdict no">残念 ✗</span>`;
  const yourAns = (mode === 'type' && session.typed != null)
    ? `<div class="your-ans">あなたの答え: <b>${esc(session.typed) || '—'}</b></div>` : '';

  // typed answers: wrong = Again/Hard only, right = Hard/Good/Easy
  let allow = [1, 2, 3, 4];
  if (mode === 'type') allow = (sc === 'correct') ? [2, 3, 4] : (sc === 'almost') ? [1, 2, 3] : [1, 2];

  // 仕上げ: write the answer N times (skipped in cram mode)
  const needWrites = (mode === 'handwrite' && session.mode !== 'cram') ? (settings.repeatWrites || 0) : 0;
  const writesLeft = Math.max(0, needWrites - session.writesDone);
  const consolidation = (mode === 'handwrite' && writesLeft > 0)
    ? `<div class="consolidate">
         <p class="hint">仕上げ — 正解を見ながら丁寧に書く <b>${session.writesDone}/${needWrites}</b></p>
         <canvas id="pad2" class="pad sm"></canvas>
         <div class="pad-tools">
           <button class="chip" id="pad2-undo">↶</button>
           <button class="chip" id="pad2-clear">消す</button>
           <button class="btn primary" id="pad2-next">書けた</button>
         </div>
       </div>` : '';

  el('app').innerHTML = `${progressHTML()}
    <div class="card review">
      <div class="badges">${cramBadge()}<span class="badge dir">韓国語で書く</span></div>
      <div class="prompt-meaning sm">${esc(word.meaning)}</div>
      ${verdict}
      <div class="answer big-term">${esc(word.term)} ${audioBtnHTML()}</div>
      ${word.reading ? `<div class="ipa">${esc(word.reading)}</div>` : ''}
      ${yourAns}
      ${word.example ? `<div class="example">“${esc(word.example)}”${word.exampleJa ? `<br><span class="muted">${esc(word.exampleJa)}</span>` : ''}</div>` : ''}
      ${consolidation}
      <div class="grade-wrap" ${consolidation ? 'style="opacity:.4;pointer-events:none"' : ''}>
        <p class="hint">評価</p>
        ${gradeAreaHTML(card, { allow })}
      </div>
    </div>`;
  bindAudio(word);
  if (consolidation) {
    const p2 = new HandwritingPad(el('pad2'));
    el('pad2-undo').onclick = () => p2.undo();
    el('pad2-clear').onclick = () => p2.clear();
    el('pad2-next').onclick = () => {
      if (p2.isEmpty()) { toast('正解を一度書いてください'); return; }
      session.writesDone++; renderProduceReveal(card, word, mode, cloze);
    };
  } else {
    bindGrades();
  }
  if (el('rev-exit')) el('rev-exit').onclick = () => setView('home');
}

// ---------- views: home / add / browse / stats / settings ----------
async function renderHome() {
  const { queue, throttled, dueCount, newCount } = await buildQueue('全体');
  const totalWords = await db.count('words');
  const streak = (await db.getMeta('streak', { current: 0 })) || {};
  const counters = await getCounters();
  const today = counters[todayKey()] || { reviews: 0, newWords: 0 };
  const decks = await getDecks();
  const due = queue.filter((x) => x.card.state !== State.New).length;
  const fresh = new Set(queue.filter((x) => x.card.state === State.New).map((x) => x.word.id)).size;

  el('app').innerHTML = `
    <header class="home-head">
      <h1>刻印 <span class="sub">Kokuin</span></h1>
      <div class="streak ${streak.current ? 'on' : ''}">${IC.flame} ${streak.current || 0}日</div>
    </header>
    <div class="card hero">
      <div class="hero-stats">
        <div><b>${due}</b><span>復習待ち</span></div>
        <div><b>${fresh}</b><span>今日の新出</span></div>
        <div><b>${totalWords}</b><span>全単語</span></div>
      </div>
      ${throttled ? `<p class="warn">復習が${dueCount}枚たまっています。キューが減るまで新出単語はいったん停止します。</p>` : ''}
      <button class="btn primary big" id="start" ${queue.length ? '' : 'disabled'}>
        ${queue.length ? `復習開始 (${queue.length}枚)` : '今日の復習完了 🎉'}
      </button>
      ${queue.length ? `<p class="hint queue-mix">${[due ? `復習 ${due}枚` : '', fresh ? `新出 ${fresh}語 × 2方向` : ''].filter(Boolean).join(' + ')} = ${queue.length}枚</p>` : ''}
      ${decks.length > 1 ? `<select id="deck-pick" class="deck-pick"><option value="全体">すべてのデッキ</option>${decks.map((d) => `<option>${esc(d)}</option>`).join('')}</select>` : ''}
      ${totalWords ? `<button class="btn big" id="cram-open">${IC.clipboard} 復習モード — スケジュール無視で総ざらい</button>` : ''}
      ${totalWords ? `<button class="btn big" id="practice-open">${IC.mic} 発音・リスニング練習</button>` : ''}
    </div>
    <div class="card mini">
      <p class="muted">今日: 復習 ${today.reviews}枚 · 新出 ${today.newWords}語</p>
      <p class="hint">カギは 分散反復 + 能動想起 + 即時フィードバック。毎日少しずつが秘訣です。</p>
    </div>
    ${totalWords === 0 ? `<div class="card empty"><p>まだ単語がありません。</p><button class="btn" id="go-add">単語を追加する</button></div>` : ''}`;
  const start = el('start');
  if (start) start.onclick = () => startReview(el('deck-pick') ? el('deck-pick').value : '全体');
  if (el('go-add')) el('go-add').onclick = () => setView('add');
  if (el('cram-open')) el('cram-open').onclick = () => setView('cram');
  if (el('practice-open')) el('practice-open').onclick = () => setView('practice');
}

// 復習モードの設定画面
async function renderCramSetup() {
  const decks = await getDecks();
  const words = await db.all('words');
  const now = Date.now();
  el('app').innerHTML = `
    <header class="view-head"><button class="link" id="back">← ホーム</button><h2>復習モード</h2></header>
    <div class="card">
      <p class="hint">選んだ単語を<b>残らず全部</b>テストします。間違えたカードは正解するまで出続け、
        復習スケジュール(FSRS)には<b>反映されません</b>。今日追加した単語をすぐ点検したいときに使ってください。</p>
      <label>範囲
        <select id="cram-scope">
          <option value="today">今日追加した単語</option>
          <option value="week">直近7日に追加</option>
          <option value="all">全体</option>
        </select></label>
      ${decks.length > 1 ? `<label>デッキ
        <select id="cram-deck"><option value="全体">すべてのデッキ</option>${decks.map((d) => `<option>${esc(d)}</option>`).join('')}</select></label>` : ''}
      <label>方向
        <select id="cram-dir">
          <option value="both">両方 (意味を思い出す + 韓国語で書く)</option>
          <option value="recall">意味を思い出すだけ (韓→日)</option>
          <option value="produce">韓国語で書くだけ (日→韓)</option>
        </select></label>
      <button class="btn primary big" id="cram-start">復習開始</button>
    </div>`;
  el('back').onclick = () => setView('home');
  // counts are for the selected deck
  const updateCounts = () => {
    const deckSel = el('cram-deck') ? el('cram-deck').value : '全体';
    const pool = words.filter((w) => deckSel === '全体' || (w.deck || '基本') === deckSel);
    const nToday = pool.filter((w) => todayKey(w.createdAt) === todayKey(now)).length;
    const nWeek = pool.filter((w) => now - w.createdAt <= 7 * DAY).length;
    const sc = el('cram-scope');
    sc.options[0].textContent = `今日追加した単語 (${nToday}個)`;
    sc.options[1].textContent = `直近7日に追加 (${nWeek}個)`;
    sc.options[2].textContent = `全体 (${pool.length}個)`;
  };
  if (el('cram-deck')) el('cram-deck').onchange = updateCounts;
  updateCounts();
  el('cram-start').onclick = () => startCram({
    scope: el('cram-scope').value,
    deck: el('cram-deck') ? el('cram-deck').value : '全体',
    dir: el('cram-dir').value,
  });
}

// 発音・リスニング練習の設定画面
async function renderPracticeSetup() {
  const decks = await getDecks();
  const words = await db.all('words');
  const now = Date.now();
  const micNote = speech.recognitionAvailable
    ? 'スピーキングは、この端末で音声の自動採点に対応しています。'
    : 'この端末は音声の自動採点に非対応のため、スピーキングは自分で採点します。(リスニング・ディクテーションは正常に動作)';
  el('app').innerHTML = `
    <header class="view-head"><button class="link" id="back">← ホーム</button><h2>発音・リスニング練習</h2></header>
    <div class="card">
      <p class="hint">単語を<b>耳で聞き、口で言う</b>練習です。復習スケジュール(FSRS)には反映されません。
        ${esc(micNote)}</p>
      <label>ドリル
        <select id="p-drill">
          <option value="shadow">シャドーイング — 聞いてまねして発音</option>
          <option value="dictation">ディクテーション — 聞いて書き取り</option>
          <option value="speak">スピーキング — 意味を見て韓国語で言う</option>
        </select></label>
      <label>範囲
        <select id="p-scope">
          <option value="today">今日追加した単語</option>
          <option value="week">直近7日に追加</option>
          <option value="all">全体</option>
        </select></label>
      ${decks.length > 1 ? `<label>デッキ
        <select id="p-deck"><option value="全体">すべてのデッキ</option>${decks.map((d) => `<option>${esc(d)}</option>`).join('')}</select></label>` : ''}
      <button class="btn primary big" id="p-start">練習開始</button>
    </div>`;
  el('back').onclick = () => setView('home');
  const updateCounts = () => {
    const deckSel = el('p-deck') ? el('p-deck').value : '全体';
    const pool = words.filter((w) => deckSel === '全体' || (w.deck || '基本') === deckSel);
    const nToday = pool.filter((w) => todayKey(w.createdAt) === todayKey(now)).length;
    const nWeek = pool.filter((w) => now - w.createdAt <= 7 * DAY).length;
    const sc = el('p-scope');
    sc.options[0].textContent = `今日追加した単語 (${nToday}個)`;
    sc.options[1].textContent = `直近7日に追加 (${nWeek}個)`;
    sc.options[2].textContent = `全体 (${pool.length}個)`;
  };
  if (el('p-deck')) el('p-deck').onchange = updateCounts;
  updateCounts();
  el('p-start').onclick = () => startPractice({
    scope: el('p-scope').value,
    deck: el('p-deck') ? el('p-deck').value : '全体',
    drill: el('p-drill').value,
  });
}

function addFormHTML(v = {}) {
  return `
    <label>韓国語の単語
      <div class="row">
        <input id="f-term" value="${esc(v.term)}" autocapitalize="off" autocorrect="off" spellcheck="false" lang="ko" placeholder="例: 안녕하세요">
        <button class="btn" id="f-fetch">自動取得</button>
      </div>
    </label>
    <label>意味 (日本語)<input id="f-meaning" value="${esc(v.meaning)}" placeholder="例: こんにちは"></label>
    <div id="f-cands" class="cands"></div>
    <label>読み (カナ)<input id="f-reading" value="${esc(v.reading)}" placeholder="自動取得で入ります (例: アンニョンハセヨ)"></label>
    <label>例文 (韓国語)<textarea id="f-ex" class="ex-input" rows="2" lang="ko" placeholder="自動取得または直接入力">${esc(v.example)}</textarea></label>
    <label>例文の意味 (日本語)<textarea id="f-exja" class="ex-input" rows="2" placeholder="例文の日本語訳">${esc(v.exampleJa)}</textarea></label>
    <label>画像URL (任意)<input id="f-img" value="${esc(v.image)}" placeholder="https://..."></label>
    <label>デッキ<input id="f-deck" value="${esc(v.deck || '基本')}"></label>
    <label>メモ / 連想 (任意)<input id="f-note" value="${esc(v.note)}" placeholder="自分なりの覚え方"></label>
    <input type="hidden" id="f-audio" value="${esc(v.audioUrl)}">
    <input type="hidden" id="f-pos" value="${esc(v.pos)}">`;
}
function readAddForm() {
  return {
    term: el('f-term').value, meaning: el('f-meaning').value, reading: el('f-reading').value,
    example: el('f-ex').value, exampleJa: el('f-exja').value, image: el('f-img').value,
    deck: el('f-deck').value || '基本', note: el('f-note').value,
    audioUrl: el('f-audio').value, pos: el('f-pos').value,
  };
}
async function fillFromLookup() {
  const termInput = el('f-term');
  const term = termInput.value.trim();
  if (!term) { toast('先に韓国語の単語を入力してください'); return; }
  const btn = el('f-fetch'); btn.disabled = true; btn.textContent = '取得中…';
  try {
    const r = await dict.lookup(term);
    // lookup is slow; ignore the result if the form changed meanwhile
    if (!document.contains(termInput) || termInput.value.trim() !== term) return;
    if (!el('f-meaning').value) el('f-meaning').value = r.meaning || '';
    if (!el('f-reading').value) el('f-reading').value = r.reading || '';
    const exWasEmpty = !el('f-ex').value;
    if (exWasEmpty) el('f-ex').value = r.example || '';
    // exampleJa only goes with r.example
    if (exWasEmpty && !el('f-exja').value) el('f-exja').value = r.exampleJa || '';
    el('f-audio').value = r.audioUrl || el('f-audio').value;
    el('f-pos').value = r.pos || el('f-pos').value;
    renderCandChips(r);
    if (r.meaning || r.reading) toast('自動取得しました — 意味の候補をタップして選べます');
    else toast(navigator.onLine === false ? 'オフラインです — 直接入力するかオンラインで再試行してください' : '辞書結果が少ないです — 直接入力してください');
  } catch { toast('取得失敗 (オフラインかもしれません)'); }
  if (document.contains(btn)) { btn.disabled = false; btn.textContent = '自動取得'; }
}

// meaning candidates as chips: tap to add to 意味, tap again to remove
function renderCandChips(r) {
  const box = el('f-cands');
  if (!box) return;
  const cands = (r.candidates || []).slice(0, 12);
  if (!cands.length) { box.innerHTML = ''; return; }
  box.innerHTML = cands.map((c) => `
    <button type="button" class="chip cand" data-g="${esc(c.gloss)}">
      ${c.pos ? `<span class="cand-pos">${esc(c.pos)}</span>` : ''}${esc(c.gloss)}${c.src === 'deck' ? ' ✓' : ''}
    </button>`).join('');
  // recompute from the input value so manual edits stay in sync
  const syncChips = () => {
    const v = el('f-meaning').value;
    box.querySelectorAll('.cand').forEach((b) => b.classList.toggle('active', v.includes(b.dataset.g)));
  };
  box.querySelectorAll('.cand').forEach((b) => {
    b.onclick = () => {
      const inp = el('f-meaning');
      const g = b.dataset.g;
      if (inp.value.includes(g)) {
        inp.value = inp.value.replace(g, '').replace(/\s*[、,]\s*[、,]\s*/g, '、').replace(/^\s*[、,]\s*|\s*[、,]\s*$/g, '').trim();
      } else {
        inp.value = inp.value.trim() ? `${inp.value.replace(/\s*[、,]\s*$/, '')}、${g}` : g;
      }
      syncChips();
    };
  });
  el('f-meaning').addEventListener('input', syncChips);
  syncChips();
}

function renderAdd() {
  el('app').innerHTML = `
    <header class="view-head"><h2>単語の追加</h2></header>
    <div class="seg"><button class="seg-btn active" data-mode="single">1つずつ</button><button class="seg-btn" data-mode="bulk">まとめて</button><button class="seg-btn" data-mode="lib">単語帳</button></div>
    <div class="card" id="add-single">
      <form id="add-form">${addFormHTML()}
        <button type="submit" class="btn primary big">保存</button>
      </form>
    </div>
    <div class="card hidden" id="add-bulk">
      <p class="muted">韓国語の単語を1行に1つ。自動取得で意味・例文・読みを埋めて一括追加します。</p>
      <textarea id="bulk-text" class="bulk" lang="ko" placeholder="안녕하세요\n감사합니다\n사랑하다"></textarea>
      <label>デッキ<input id="bulk-deck" value="基本"></label>
      <button class="btn primary big" id="bulk-go">一括で自動取得して追加</button>
      <div id="bulk-prog" class="muted"></div>
    </div>
    <div class="card hidden" id="add-lib"><div id="lib-body"><p class="muted">読み込み中…</p></div></div>`;
  let libLoaded = false;
  document.querySelectorAll('.seg-btn').forEach((b) => b.onclick = () => {
    document.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    el('add-single').classList.toggle('hidden', b.dataset.mode !== 'single');
    el('add-bulk').classList.toggle('hidden', b.dataset.mode !== 'bulk');
    el('add-lib').classList.toggle('hidden', b.dataset.mode !== 'lib');
    if (b.dataset.mode === 'lib' && !libLoaded) { libLoaded = true; renderLibrary(); }
  });
  el('f-fetch').onclick = (e) => { e.preventDefault(); fillFromLookup(); };
  el('add-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = readAddForm();
    if (!f.term.trim()) { toast('韓国語の単語を入力してください'); return; }
    const btn = $('#add-form button[type=submit]');
    if (btn.disabled) return; // double-tap guard
    btn.disabled = true;
    await addWord(f);
    toast(`追加しました: ${f.term}`);
    autoSyncSoon();
    renderAdd();
  };
  el('bulk-go').onclick = async () => {
    const terms = el('bulk-text').value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!terms.length) { toast('単語を入力してください'); return; }
    const deck = el('bulk-deck').value || '基本';
    const prog = el('bulk-prog'); const btn = el('bulk-go');
    btn.disabled = true;
    const run = { stop: false };
    bulkRun = run;
    let n = 0, failed = 0;
    try {
      await dict.lookupMany(terms, async (r) => {
        await addWord({ ...r, deck });
        n++;
        if (document.contains(prog)) prog.textContent = `進行: ${n}/${terms.length} — ${r.term}`;
      }, {
        stopped: () => run.stop,
        onError: () => { failed++; },
      });
      toast(run.stop ? `一括追加を中断 — ${n}個追加` : `${n}個追加しました${failed ? ` · 失敗 ${failed}個` : ''}`);
      if (n) autoSyncSoon();
    } catch {
      toast(`一括追加エラー — ${n}個まで追加`);
    } finally {
      if (bulkRun === run) bulkRun = null;
      if (document.contains(btn)) btn.disabled = false;
      if (!run.stop && document.contains(prog)) { el('bulk-text').value = ''; prog.textContent = ''; }
    }
  };
}

// ---------- 内蔵単語帳 (built-in deck library) ----------
async function renderLibrary() {
  const body = el('lib-body');
  let index;
  try { index = await decklib.loadIndex(); }
  catch { body.innerHTML = '<p class="muted">単語帳の一覧を読み込めません。オンラインで一度開けば、以降はオフラインでも表示されます。</p>'; return; }
  body.innerHTML = `
    <p class="hint">目的に合った単語帳を選んでまるごと追加できます。すでに追加済みの単語は自動でスキップします。
      追加した単語は1日の新出単語数(現在 ${settings.newWordsPerDay}個)に合わせて毎日少しずつ出題され、
      <b>復習モード</b>ではすぐ全部テストできます。</p>
    <ul class="lib-list">${index.map((d) => `
      <li data-id="${esc(d.id)}">
        <div class="lib-main"><b>${esc(d.name)}</b><span class="lib-desc">${esc(d.desc)} · ${Number(d.count) || 0}語</span></div>
        <span class="lib-go">›</span>
      </li>`).join('')}</ul>`;
  body.querySelectorAll('.lib-list li').forEach((li) => { li.onclick = () => openLibDeck(li.dataset.id); });
}

async function openLibDeck(id) {
  const body = el('lib-body');
  body.innerHTML = '<p class="muted">読み込み中…</p>';
  let deck;
  try { deck = await decklib.loadDeck(id); }
  catch { body.innerHTML = '<p class="muted">単語帳を読み込めません。(オフライン?)</p>'; return; }
  const mine = new Set((await db.all('words')).map((w) => normalize(w.term)));
  const have = (t) => mine.has(normalize(t));
  const fresh = deck.words.filter((w) => !have(w.t));
  const dup = deck.words.length - fresh.length;
  body.innerHTML = `
    <button class="link" id="lib-back">← 単語帳一覧</button>
    <div class="lib-head"><b>${esc(deck.name)}</b><span class="muted">${esc(deck.desc || '')}</span></div>
    <p class="muted">${deck.words.length}語${dup ? ` · 追加済み ${dup}個を除外` : ''} → 追加可能 <b>${fresh.length}個</b></p>
    <div class="row">
      <button class="btn primary" id="lib-add-all" ${fresh.length ? '' : 'disabled'}>全部追加 (${fresh.length})</button>
      <button class="btn" id="lib-add-50" ${fresh.length ? '' : 'disabled'}>先頭50個だけ</button>
    </div>
    <ul class="word-list lib-preview">${deck.words.map((w) => `
      <li class="${have(w.t) ? 'have' : ''}"><div class="b-main"><b>${esc(w.t)}</b><span class="b-mean">${esc(w.m)}</span></div>${have(w.t) ? '<span class="have-tag">あり</span>' : ''}</li>`).join('')}</ul>`;
  el('lib-back').onclick = () => renderLibrary();
  const doAdd = async (list) => {
    el('lib-add-all').disabled = el('lib-add-50').disabled = true;
    const n = await bulkAddWords(
      list.map((w) => ({ term: w.t, meaning: w.m, pos: w.p, example: w.ex, exampleJa: w.exk })),
      deck.name);
    toast(`${n}個追加 → デッキ「${deck.name}」`);
    autoSyncSoon();
    openLibDeck(id); // refresh "あり" marks
  };
  el('lib-add-all').onclick = () => doAdd(fresh);
  el('lib-add-50').onclick = () => doAdd(fresh.slice(0, 50));
}

async function renderBrowse() {
  const words = (await db.all('words')).sort((a, b) => b.createdAt - a.createdAt);
  const cards = await db.all('cards');
  const cardsByWord = {};
  for (const c of cards) (cardsByWord[c.wordId] = cardsByWord[c.wordId] || []).push(c);

  function rowHTML(w) {
    const cs = cardsByWord[w.id] || [];
    const leech = cs.some((c) => c.leech);
    const states = cs.map((c) => c.state);
    const stBadge = states.every((s) => s === State.New) ? '<span class="dot new"></span>'
      : states.some((s) => s === State.Review) ? '<span class="dot rev"></span>' : '<span class="dot learn"></span>';
    return `<li data-id="${esc(w.id)}">
      <div class="b-main">${stBadge}<b>${esc(w.term)}</b> ${leech ? `<span class="leech-ic">${IC.drop}</span>` : ''}<span class="b-mean">${esc(w.meaning)}</span></div>
      <div class="b-actions"><button class="link edit" data-id="${esc(w.id)}">編集</button><button class="link del" data-id="${esc(w.id)}">削除</button></div>
    </li>`;
  }
  el('app').innerHTML = `
    <header class="view-head"><h2>単語 (${words.length})</h2></header>
    <input id="search" class="search" placeholder="検索…">
    <div class="filters">
      <button class="chip active" data-filter="all">すべて</button>
      <button class="chip" data-filter="leech">${IC.drop} よく間違える</button>
      <button class="chip" data-filter="new">新出</button>
    </div>
    <ul class="word-list" id="wlist">${words.map(rowHTML).join('') || '<p class="muted">単語がありません。</p>'}</ul>`;

  let filter = 'all';
  const apply = () => {
    const q = normalize(el('search').value);
    document.querySelectorAll('#wlist li').forEach((li) => {
      const w = words.find((x) => x.id === li.dataset.id);
      const cs = cardsByWord[w.id] || [];
      let ok = !q || normalize(w.term).includes(q) || normalize(w.meaning).includes(q);
      if (ok && filter === 'leech') ok = cs.some((c) => c.leech);
      if (ok && filter === 'new') ok = cs.every((c) => c.state === State.New);
      li.style.display = ok ? '' : 'none';
    });
  };
  el('search').oninput = apply;
  document.querySelectorAll('.chip[data-filter]').forEach((b) => b.onclick = () => {
    filter = b.dataset.filter;
    document.querySelectorAll('.chip[data-filter]').forEach((x) => x.classList.toggle('active', x === b));
    apply();
  });
  el('wlist').addEventListener('click', async (e) => {
    const id = e.target.dataset.id; if (!id) return;
    if (e.target.classList.contains('del')) {
      if (confirm('この単語を削除しますか？')) { await deleteWord(id); autoSyncSoon(); renderBrowse(); }
    } else if (e.target.classList.contains('edit')) {
      openEdit(id);
    }
  });
}

async function openEdit(id) {
  const w = await db.get('words', id);
  el('app').innerHTML = `
    <header class="view-head"><button class="link" id="back">← 一覧</button><h2>編集</h2></header>
    <div class="card"><form id="edit-form">${addFormHTML(w)}
      <button type="submit" class="btn primary big">保存</button></form></div>`;
  el('back').onclick = () => renderBrowse();
  el('f-fetch').onclick = (e) => { e.preventDefault(); fillFromLookup(); };
  el('edit-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = readAddForm();
    Object.assign(w, f, { reading: readingFor(f.term, f.reading), updatedAt: Date.now() });
    await db.put('words', w);
    // keep card decks in sync
    const cs = await db.allByIndex('cards', 'wordId', id);
    for (const c of cs) { c.deck = w.deck; await db.put('cards', c); }
    toast('保存しました'); autoSyncSoon(); renderBrowse();
  };
}

async function renderStats() {
  const cards = await db.all('cards');
  const reviews = await db.all('reviews');
  const now = Date.now();
  const since = now - 30 * DAY;
  const recent = reviews.filter((r) => r.ts >= since);
  const retention = recent.length ? Math.round((recent.filter((r) => r.correct).length / recent.length) * 100) : 0;
  const byState = { new: 0, learning: 0, review: 0, relearning: 0 };
  for (const c of cards) byState[c.state] = (byState[c.state] || 0) + 1;
  const leeches = cards.filter((c) => c.leech).length;
  const streak = (await db.getMeta('streak', { current: 0, longest: 0 })) || {};
  // 7-day due forecast
  const fc = Array.from({ length: 7 }, (_, i) => cards.filter((c) => c.state !== State.New && c.due > now + i * DAY && c.due <= now + (i + 1) * DAY).length);
  const maxFc = Math.max(1, ...fc);

  el('app').innerHTML = `
    <header class="view-head"><h2>統計</h2></header>
    <div class="card stat-grid">
      <div><b>${retention}%</b><span>30日の想起成功率</span></div>
      <div><b>${streak.current || 0}</b><span>現在の連続 (最高 ${streak.longest || 0})</span></div>
      <div><b>${byState.review || 0}</b><span>長期記憶に到達</span></div>
      <div><b>${leeches}</b><span>よく間違える単語</span></div>
    </div>
    <div class="card">
      <h3>カードの状態</h3>
      <div class="bars">
        <div class="bar"><span>新出</span><div><i style="width:${pct(byState.new, cards.length)}%"></i></div><em>${byState.new || 0}</em></div>
        <div class="bar"><span>学習中</span><div><i style="width:${pct((byState.learning || 0) + (byState.relearning || 0), cards.length)}%"></i></div><em>${(byState.learning || 0) + (byState.relearning || 0)}</em></div>
        <div class="bar"><span>復習</span><div><i style="width:${pct(byState.review, cards.length)}%"></i></div><em>${byState.review || 0}</em></div>
      </div>
    </div>
    <div class="card">
      <h3>これから7日間の復習量</h3>
      <div class="forecast">${fc.map((n, i) => `<div class="fc-col"><div class="fc-bar" style="height:${Math.round((n / maxFc) * 80) + 4}px"></div><span>${i === 0 ? '明日' : `+${i + 1}`}</span><em>${n}</em></div>`).join('')}</div>
    </div>`;
  function pct(a, b) { return b ? Math.round((a / b) * 100) : 0; }
}

async function renderSettings() {
  const decks = await getDecks();
  el('app').innerHTML = `
    <header class="view-head"><h2>設定</h2></header>
    <div class="card">
      <label class="set">1日の新出単語数: <b id="v-new">${settings.newWordsPerDay}</b>
        <input type="range" id="s-new" min="3" max="40" value="${settings.newWordsPerDay}"></label>
      <p class="hint">新出を増やすほど、数日後の復習量が雪だるま式に増えます。15〜20個がおすすめ。</p>

      <label class="set">目標の記憶保持率: <b id="v-ret">${Math.round(settings.requestRetention * 100)}%</b>
        <input type="range" id="s-ret" min="80" max="95" value="${Math.round(settings.requestRetention * 100)}"></label>
      <p class="hint">高いほど復習頻度が上がります。90%がおすすめ (95%は復習量が約2倍)。</p>

      <label class="set">産出(韓国語で書く)の既定入力
        <select id="s-input">
          <option value="handwrite" ${settings.productiveInput === 'handwrite' ? 'selected' : ''}>手書き (Apple Pencil)</option>
          <option value="type" ${settings.productiveInput === 'type' ? 'selected' : ''}>タイピング</option>
        </select></label>
      <p class="hint">根拠: タイピングと手書きの効果は同程度です。手書きはつづり形態にわずかな利点があり、オプションとして手厚く対応しています。</p>

      <label class="set">手書きの仕上げ回数: <b id="v-rep">${settings.repeatWrites}</b>回
        <input type="range" id="s-rep" min="0" max="5" value="${settings.repeatWrites}"></label>
      <p class="hint">正解確認後に丁寧に書く回数。ただし本当の定着は同じ日に何度もより<b>日を空けた反復</b>で起こります。</p>

      <label class="set">よく間違える(リーチ)基準: <b id="v-leech">${settings.leechLapses}</b>回 忘却
        <input type="range" id="s-leech" min="2" max="8" value="${settings.leechLapses}"></label>

      <label class="set">テーマ
        <select id="s-theme">
          <option value="auto" ${settings.theme === 'auto' ? 'selected' : ''}>システム設定に従う</option>
          <option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>ダーク</option>
          <option value="light" ${settings.theme === 'light' ? 'selected' : ''}>ライト</option>
        </select></label>
    </div>
    <div class="card">
      <h3>端末間の同期</h3>
      <p class="hint">同じ<b>同期パスワード</b>を入れた端末同士で、単語と学習記録が自動で統合されます (iPhoneで追加 → iPadで復習)。データは端末で暗号化してからアップロードされ、サーバーも中身を見られません。テーマなど端末の設定は同期されません。最初の1回だけCloudflare KVの接続が必要です (README参照)。</p>
      <p class="hint">このパスワードがデータを解く鍵です — <b>8文字以上の、他人に推測されない語句</b>にして、忘れないでください。(誕生日・メールのようなありふれた値は他人と衝突しデータが混ざる恐れがあります。)</p>
      <label>同期パスワード<input id="s-sync-pass" type="password" value="${esc(getSyncPass())}" placeholder="8文字以上・端末間で同一に" autocomplete="off" minlength="8"></label>
      <div class="row" style="margin-top:12px">
        <button class="btn primary" id="sync-now">今すぐ同期</button>
        <label class="check-inline"><input type="checkbox" id="s-sync-auto" ${getSyncAuto() ? 'checked' : ''}> 自動 (起動時・復習後)</label>
      </div>
      <p class="hint" id="sync-status">${(() => { try { const t = +localStorage.getItem('kokuin-sync-last'); return t ? `最終同期: ${new Date(t).toLocaleString('ja-JP')}` : 'まだ同期したことがありません'; } catch { return ''; } })()}</p>
    </div>
    <div class="card">
      <h3>バックアップ / 復元</h3>
      <p class="hint">データはこの端末にだけ保存されます(サーバーなし)。ただし「自動取得」・発音を使うと、入力した単語・例文が辞書/翻訳API(translate.googleapis.com、MyMemory)へ送信されます。ときどきエクスポートしてバックアップしてください。</p>
      <div class="row">
        <button class="btn" id="export">エクスポート (JSON)</button>
        <button class="btn" id="import-btn">インポート</button>
        <input type="file" id="import-file" accept="application/json" class="hidden">
      </div>
    </div>
    <div class="card">
      <h3>デッキ (${decks.length})</h3>
      <p class="muted">${decks.map(esc).join(', ') || 'なし'}</p>
    </div>`;

  // fill the slider track up to the thumb
  const paintRange = (s) => {
    const p = ((+s.value - +s.min) / (+s.max - +s.min)) * 100;
    s.style.background = `linear-gradient(90deg, var(--brand) ${p}%, var(--card2) ${p}%)`;
  };
  const bind = (id, vId, fn) => {
    const s = el(id);
    paintRange(s);
    s.oninput = () => { el(vId).textContent = fn(s.value); paintRange(s); };
    s.onchange = () => save();
  };
  bind('s-new', 'v-new', (v) => v);
  bind('s-ret', 'v-ret', (v) => v + '%');
  bind('s-rep', 'v-rep', (v) => v);
  bind('s-leech', 'v-leech', (v) => v);
  el('s-input').onchange = () => save();
  el('s-theme').onchange = () => save();
  async function save() {
    settings.newWordsPerDay = +el('s-new').value;
    settings.requestRetention = +el('s-ret').value / 100;
    settings.repeatWrites = +el('s-rep').value;
    settings.leechLapses = +el('s-leech').value;
    settings.productiveInput = el('s-input').value;
    settings.theme = el('s-theme').value;
    applyTheme();
    await saveSettings(); toast('保存しました');
  }
  el('export').onclick = exportData;
  el('import-btn').onclick = () => el('import-file').click();
  el('import-file').onchange = (e) => importData(e.target.files[0]);
  el('s-sync-pass').onchange = () => setSyncPass(el('s-sync-pass').value.trim());
  el('s-sync-auto').onchange = () => setSyncAuto(el('s-sync-auto').checked);
  el('sync-now').onclick = () => { setSyncPass(el('s-sync-pass').value.trim()); runSync(true); };
}

async function exportData() {
  const data = {
    app: 'kokuin', version: 1, exportedAt: new Date().toISOString(),
    words: await db.all('words'), cards: await db.all('cards'),
    reviews: await db.all('reviews'),
    meta: { settings, streak: await db.getMeta('streak', {}), counters: await getCounters() },
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `kokuin-backup-${todayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// ---- import sanitization ----
// backups are untrusted: rebuild each record with known fields and length limits
const _str = (v, max = 2000) => String(v == null ? '' : v).slice(0, max);
const _httpsUrl = (v) => { const s = _str(v, 2000); return /^https:\/\//i.test(s) ? s : ''; };
const _VALID_STATES = new Set(Object.values(State));
function sanitizeWord(w) {
  if (!w || typeof w !== 'object') return null;
  return {
    id: _str(w.id, 64) || uid(),
    term: _str(w.term, 200), meaning: _str(w.meaning, 1000), reading: _str(w.reading, 200),
    pos: _str(w.pos, 50), example: _str(w.example, 1000), exampleJa: _str(w.exampleJa, 1000),
    audioUrl: _httpsUrl(w.audioUrl), image: _httpsUrl(w.image), note: _str(w.note, 2000),
    deck: _str(w.deck, 100) || '基本', createdAt: Number(w.createdAt) || Date.now(),
    updatedAt: Number(w.updatedAt) || Number(w.createdAt) || Date.now(),
  };
}
function sanitizeCard(c) {
  if (!c || typeof c !== 'object') return null;
  return {
    id: _str(c.id, 64) || uid(), wordId: _str(c.wordId, 64),
    direction: c.direction === 'produce' ? 'produce' : 'recall',
    deck: _str(c.deck, 100) || '基本', state: _VALID_STATES.has(c.state) ? c.state : State.New,
    stability: c.stability == null ? null : Number(c.stability),
    difficulty: c.difficulty == null ? null : Number(c.difficulty),
    due: Number(c.due) || Date.now(), reps: Number(c.reps) || 0, lapses: Number(c.lapses) || 0,
    lastReview: c.lastReview == null ? null : Number(c.lastReview),
    leech: !!c.leech, suspended: !!c.suspended, createdAt: Number(c.createdAt) || Date.now(),
  };
}
function sanitizeReview(r) {
  if (!r || typeof r !== 'object') return null;
  const out = {
    cardId: _str(r.cardId, 64), wordId: _str(r.wordId, 64),
    direction: r.direction === 'produce' ? 'produce' : 'recall',
    rating: Math.min(4, Math.max(1, Math.round(Number(r.rating)) || 1)),
    ts: Number(r.ts) || Date.now(), correct: !!r.correct,
  };
  if (Number.isInteger(r.id)) out.id = r.id; // reviews store uses autoIncrement keyPath 'id'
  return out;
}
function sanitizeSettings(s) {
  if (!s || typeof s !== 'object') return {};
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  return {
    newWordsPerDay: Math.min(40, Math.max(1, Math.round(num(s.newWordsPerDay, DEFAULT_SETTINGS.newWordsPerDay)))),
    requestRetention: Math.min(0.97, Math.max(0.7, num(s.requestRetention, DEFAULT_SETTINGS.requestRetention))),
    maximumInterval: Math.max(1, Math.round(num(s.maximumInterval, DEFAULT_SETTINGS.maximumInterval))),
    leechLapses: Math.min(12, Math.max(1, Math.round(num(s.leechLapses, DEFAULT_SETTINGS.leechLapses)))),
    productiveInput: s.productiveInput === 'type' ? 'type' : 'handwrite',
    repeatWrites: Math.min(10, Math.max(0, Math.round(num(s.repeatWrites, DEFAULT_SETTINGS.repeatWrites)))),
    backlogThrottle: Math.max(0, Math.round(num(s.backlogThrottle, DEFAULT_SETTINGS.backlogThrottle))),
    autoFetch: typeof s.autoFetch === 'boolean' ? s.autoFetch : DEFAULT_SETTINGS.autoFetch,
    theme: ['auto', 'dark', 'light'].includes(s.theme) ? s.theme : DEFAULT_SETTINGS.theme,
  };
}
// these end up in innerHTML, so force numbers
function sanitizeStreak(s) {
  if (!s || typeof s !== 'object') return { current: 0, longest: 0, last: null };
  const n = (v) => { const x = Math.round(Number(v)); return Number.isFinite(x) && x >= 0 ? x : 0; };
  return { current: n(s.current), longest: n(s.longest), last: s.last == null ? null : n(s.last) };
}
function sanitizeCounters(c) {
  if (!c || typeof c !== 'object') return {};
  const out = {};
  const n = (v) => { const x = Math.round(Number(v)); return Number.isFinite(x) && x >= 0 ? x : 0; };
  for (const [k, v] of Object.entries(c)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !v || typeof v !== 'object') continue;
    out[k] = { newWords: n(v.newWords), reviews: n(v.reviews) };
  }
  return out;
}

async function importData(file) {
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { toast('インポート失敗: JSONを読み込めません'); return; }
  if (!data || typeof data !== 'object' || data.app !== 'kokuin') {
    toast('インポート失敗: 刻印のバックアップ形式ではありません'); return;
  }
  if (!Array.isArray(data.words) || !Array.isArray(data.cards)) {
    toast('インポート失敗: 破損したバックアップ'); return;
  }
  // validate everything before deleting anything
  const words = data.words.map(sanitizeWord).filter(Boolean);
  const cards = data.cards.map(sanitizeCard).filter(Boolean);
  const reviews = Array.isArray(data.reviews) ? data.reviews.map(sanitizeReview).filter(Boolean) : [];
  if (!confirm(`インポートすると現在のデータを上書きします。単語 ${words.length}個を復元しますか？`)) return;
  try {
    await db.clearStore('words'); await db.clearStore('cards'); await db.clearStore('reviews');
    await db.bulkPut('words', words);
    await db.bulkPut('cards', cards);
    await db.bulkPut('reviews', reviews);
    const m = data.meta && typeof data.meta === 'object' ? data.meta : {};
    if (m.settings && typeof m.settings === 'object') { settings = { ...DEFAULT_SETTINGS, ...sanitizeSettings(m.settings) }; await saveSettings(); applyTheme(); }
    if (m.streak && typeof m.streak === 'object') await db.setMeta('streak', sanitizeStreak(m.streak));
    if (m.counters && typeof m.counters === 'object') await db.setMeta('counters', sanitizeCounters(m.counters));
    toast('復元しました'); renderSettings();
  } catch (err) { toast('インポート失敗: ' + err.message); }
}

// ---------- nav / router ----------
const VIEWS = { home: renderHome, add: renderAdd, browse: renderBrowse, stats: renderStats, settings: renderSettings, cram: renderCramSetup, practice: renderPracticeSetup };
let currentView = 'home';
// tab bar icons
const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
  browse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19a2 2 0 0 0 2 2h13"/></svg>',
  stats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.5a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.5h4l.4-2.5a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.06-.4.1-.8.1-1.2z"/></svg>',
};
function renderTabbar() {
  const tabs = [['home', 'ホーム'], ['add', '追加'], ['browse', '単語'], ['stats', '統計'], ['settings', '設定']];
  el('tabbar').innerHTML = tabs.map(([v, t]) => `<button data-nav="${v}" class="${currentView === v ? 'active' : ''}">${ICONS[v]}${t}</button>`).join('');
  el('tabbar').style.display = currentView === 'review' ? 'none' : '';
  document.querySelectorAll('#tabbar [data-nav]').forEach((b) => b.onclick = () => setView(b.dataset.nav));
}
function setView(v) {
  if (v !== 'review' && session) {
    if (session.micJob) { try { session.micJob.cancel(); } catch { /* ignore */ } }
    session = null; pad = null; // leaving ends the review
  }
  try { stopAudio(); } catch { /* ignore */ } // stop TTS
  currentView = v;
  hideToast();
  if (bulkRun) bulkRun.stop = true; // cancel bulk add
  renderTabbar();
  window.scrollTo(0, 0);
  if (VIEWS[v]) VIEWS[v]();
}

// ---------- init ----------
async function init() {
  await db.openDB();
  await loadSettings();
  applyTheme();
  try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme); } catch { /* old Safari */ }
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./sw.js'); } catch {}
  }
  window.addEventListener('resize', () => { if (pad) pad.resize(); });
  setView('home');
  autoSync(); // pull changes from other devices
}
init();
