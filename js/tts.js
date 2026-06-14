// pronunciation: dictionary audio if available, otherwise speechSynthesis
let voices = [];
function loadVoices() { try { voices = window.speechSynthesis.getVoices() || []; } catch { voices = []; } }
if ('speechSynthesis' in window) { loadVoices(); window.speechSynthesis.onvoiceschanged = loadVoices; }

// only one sound at a time
let curAudio = null;
function stopAll() {
  try { window.speechSynthesis.cancel(); } catch { /* no-op */ }
  if (curAudio) { try { curAudio.pause(); curAudio.currentTime = 0; } catch { /* no-op */ } curAudio = null; }
}
export function stop() { stopAll(); }

export function speak(text, lang = 'ko-KR', rate = 0.95) {
  if (!('speechSynthesis' in window) || !text) return;
  try {
    stopAll();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    const base = lang.split('-')[0];
    const v = voices.find((x) => x.lang === lang) || voices.find((x) => x.lang && x.lang.startsWith(base));
    if (v) u.voice = v;
    u.rate = rate;
    window.speechSynthesis.speak(u);
  } catch { /* no-op */ }
}

// plays the audio URL or falls back to TTS; always resolves
export function pronounce(text, audioUrl, lang = 'ko-KR') {
  return new Promise((resolve) => {
    stopAll();
    if (audioUrl) {
      try {
        const a = new Audio(audioUrl);
        curAudio = a;
        a.onended = resolve;
        a.onerror = () => { speak(text, lang); resolve(); };
        a.play().catch(() => { speak(text, lang); resolve(); });
        return;
      } catch { /* fall through */ }
    }
    speak(text, lang);
    resolve();
  });
}
