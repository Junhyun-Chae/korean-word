// FSRS-5 with the default weights (based on open-spaced-repetition/ts-fsrs)
// state: stability S in days, difficulty D in 1..10
// retrievability R(t) = (1 + FACTOR * t / S) ^ DECAY

export const DEFAULT_W = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575,
  0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
];

const DECAY = -0.5;
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1; // ≈ 0.2345679

export const Rating = { Again: 1, Hard: 2, Good: 3, Easy: 4 };
export const State = { New: 'new', Learning: 'learning', Review: 'review', Relearning: 'relearning' };

const clampD = (d) => Math.min(Math.max(d, 1), 10);
const DAY = 86400000;

export function retrievability(elapsedDays, stability) {
  if (!stability || stability <= 0) return 0;
  return Math.pow(1 + FACTOR * elapsedDays / stability, DECAY);
}

// Days until retrievability falls to requestRetention.
export function intervalDays(stability, requestRetention = 0.9, maxInterval = 36500) {
  const i = (stability / FACTOR) * (Math.pow(requestRetention, 1 / DECAY) - 1);
  return Math.min(Math.max(Math.round(i), 1), maxInterval);
}

const initStability = (w, g) => Math.max(w[g - 1], 0.1);
const initDifficulty = (w, g) => clampD(w[4] - Math.exp(w[5] * (g - 1)) + 1);

function nextDifficulty(w, d, g) {
  const deltaD = -w[6] * (g - 3);
  const dp = d + deltaD * ((10 - d) / 9); // linear damping (FSRS-5)
  const meanRev = w[7] * initDifficulty(w, Rating.Easy) + (1 - w[7]) * dp;
  return clampD(meanRev);
}

function nextRecallStability(w, d, s, r, g) {
  const hardPenalty = g === Rating.Hard ? w[15] : 1;
  const easyBonus = g === Rating.Easy ? w[16] : 1;
  return s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9])
    * (Math.exp(w[10] * (1 - r)) - 1) * hardPenalty * easyBonus);
}

function nextForgetStability(w, d, s, r) {
  const sf = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp(w[14] * (1 - r));
  return Math.max(Math.min(sf, s), 0.1); // post-lapse stability shouldn't exceed prior
}

// returns the new scheduling fields for a card and a rating
export function schedule(card, rating, now = Date.now(), opts = {}) {
  const w = opts.w || DEFAULT_W;
  const reqRet = opts.requestRetention ?? 0.9;
  const maxInt = opts.maximumInterval ?? 36500;
  const g = rating;
  let { stability, difficulty, state, reps = 0, lapses = 0, lastReview } = card;
  const isNew = state === State.New || stability == null;
  const elapsedDays = isNew || !lastReview ? 0 : Math.max(0, (now - lastReview) / DAY);

  if (isNew) {
    stability = initStability(w, g);
    difficulty = initDifficulty(w, g);
    reps = 1;
    state = g === Rating.Again ? State.Learning : State.Review;
  } else {
    const r = retrievability(elapsedDays, stability);
    difficulty = nextDifficulty(w, difficulty, g);
    if (g === Rating.Again) {
      stability = nextForgetStability(w, difficulty, stability, r);
      lapses += 1;
      state = State.Relearning;
    } else {
      stability = nextRecallStability(w, difficulty, stability, r, g);
      state = State.Review;
    }
    reps += 1;
  }
  stability = Math.max(stability, 0.1);

  let interval = intervalDays(stability, reqRet, maxInt);
  let due;
  if (g === Rating.Again) {
    interval = 0;
    due = now + 5 * 60 * 1000; // re-show in ~5 min (session also re-queues it)
  } else {
    if (interval < 1) interval = 1;
    due = now + interval * DAY;
  }
  return { stability, difficulty, state, reps, lapses, lastReview: now, interval, due };
}

// interval in days for each button (0 = under a day), shown on the buttons
export function previewIntervals(card, now = Date.now(), opts = {}) {
  const out = {};
  for (const g of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]) {
    out[g] = schedule({ ...card }, g, now, opts).interval;
  }
  return out;
}
