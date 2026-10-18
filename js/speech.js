// Korean speech recognition (Web Speech API). Support on iOS Safari is spotty,
// so callers have to handle the unsupported/failed case. Playback is in tts.js.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const recognitionAvailable = !!SR;

// Returns { promise, cancel }.
//   promise: resolves to the alternative transcripts, best first, or rejects with
//            Error(code): unsupported | timeout | no-speech | aborted | <browser error>.
//   cancel(): stops listening; the promise then rejects with 'aborted'.
// On iOS it can hang until the timeout, so callers should check they're still on the screen.
export function listen(lang = 'ko-KR', { timeoutMs = 8000 } = {}) {
  let rec = null, done = false, t = null, settle = null;
  const promise = new Promise((resolve, reject) => {
    settle = (ok, val) => {
      if (done) return; done = true;
      clearTimeout(t);
      try { if (rec) rec.stop(); } catch { /* already stopped */ }
      (ok ? resolve : reject)(val);
    };
    if (!SR) { settle(false, new Error('unsupported')); return; }
    try { rec = new SR(); } catch { settle(false, new Error('unsupported')); return; }
    rec.lang = lang;
    rec.interimResults = false;
    rec.maxAlternatives = 4;
    t = setTimeout(() => settle(false, new Error('timeout')), timeoutMs);
    rec.onresult = (e) => {
      const alts = [];
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        for (let j = 0; j < r.length; j++) if (r[j].transcript) alts.push(r[j].transcript);
      }
      if (alts.length) settle(true, alts); else settle(false, new Error('no-speech'));
    };
    rec.onerror = (e) => settle(false, new Error((e && e.error) || 'error'));
    rec.onend = () => settle(false, new Error('no-speech'));
    try { rec.start(); } catch { settle(false, new Error('start-failed')); }
  });
  const cancel = () => {
    try { if (rec && rec.abort) rec.abort(); } catch { /* ignore */ }
    if (settle) settle(false, new Error('aborted'));
  };
  return { promise, cancel };
}
