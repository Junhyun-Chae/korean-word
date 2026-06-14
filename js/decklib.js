// built-in decks (内蔵単語帳) from data/decks/
async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

let _index = null;
export async function loadIndex() {
  if (!_index) _index = await jget('./data/decks/index.json');
  return _index;
}

export async function loadDeck(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('bad deck id');
  return jget(`./data/decks/${id}.json`);
}
