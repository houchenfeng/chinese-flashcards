export const STAGE = { NEW: 0, IMMEDIATE: 1, SAME_DAY: 2, NEXT_DAY: 3, LEARNED: 4 };
export const KIND = { NEW: 'new', REDO: 'redo', DUE: 'due', LIGHT: 'light' };
export const STORAGE_KEY = 'zw.state';
export const HISTORY_LIMIT = 30;

const DEFAULT_SETTINGS = { dailyNew: 30, autoSpeak: true, rate: 'normal', lightCount: 10 };
const REVIEW_STAGES = [STAGE.IMMEDIATE, STAGE.SAME_DAY, STAGE.NEXT_DAY];

export function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return dateKey(new Date(y, m - 1, d + n));
}

export function newProgress() {
  return {
    stage: STAGE.NEW,
    everStudied: false,
    due: null,
    lastSeen: null,
    wrongCount: 0,
    firstTryCorrect: false,
    poolEnteredAt: null,
    retired: false,
  };
}

function emptyStats() {
  return { answers: 0, correct: 0, wrong: 0, firstTryCorrect: 0 };
}

export function emptyToday(date, targetNew = 0) {
  return {
    date,
    targetNew,
    doneNew: 0,
    seenNew: [],
    queue: [],
    queuePos: 0,
    pendingRequeue: [],
    stats: emptyStats(),
    wrongIds: [],
    startedAt: null,
    finishedAt: null,
  };
}

export function createState(words, settings = {}) {
  const progress = {};
  for (const w of words) progress[w.id] = newProgress();
  const today = emptyToday(dateKey(), 0);
  return {
    version: 1,
    wordBankVersion: null,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    progress,
    today,
    history: [],
  };
}

export function shuffle(list, rng) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function countFresh(words, progress) {
  return words.filter((w) => {
    const p = progress[w.id];
    return p && !p.retired && !p.everStudied && p.stage === STAGE.NEW;
  }).length;
}

export function computeTarget(state, words) {
  return Math.min(state.settings.dailyNew, countFresh(words, state.progress));
}

export function migrateState(state, words, version) {
  const ids = new Set(words.map((w) => w.id));
  const added = [];
  for (const w of words) {
    if (!state.progress[w.id]) {
      state.progress[w.id] = newProgress();
      added.push(w.id);
    }
  }
  const removed = [];
  for (const id of Object.keys(state.progress)) {
    if (!ids.has(id)) {
      state.progress[id].retired = true;
      removed.push(id);
    }
  }
  state.wordBankVersion = version;
  return { added, removed };
}

export function loadState(storage, words, { version = null } = {}) {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) {
    const state = createState(words);
    if (version) state.wordBankVersion = version;
    return { state, status: 'empty' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const state = createState(words);
    if (version) state.wordBankVersion = version;
    return { state, status: 'corrupted' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const state = createState(words);
    if (version) state.wordBankVersion = version;
    return { state, status: 'corrupted' };
  }

  const state = createState(words);
  const repaired = [];
  state.version = typeof parsed.version === 'number' ? parsed.version : 1;
  state.wordBankVersion = typeof parsed.wordBankVersion === 'string' ? parsed.wordBankVersion : null;
  if (!parsed.settings || typeof parsed.settings !== 'object') repaired.push('settings');
  state.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {}) };
  for (const [k, v] of Object.entries(state.settings)) {
    if (typeof state.settings[k] !== typeof DEFAULT_SETTINGS[k]) state.settings[k] = DEFAULT_SETTINGS[k];
  }
  if (!parsed.progress || typeof parsed.progress !== 'object') repaired.push('progress');
  for (const [id, p] of Object.entries(parsed.progress && typeof parsed.progress === 'object' ? parsed.progress : {})) {
    if (!state.progress[id] || !p || typeof p !== 'object') continue;
    state.progress[id] = { ...newProgress(), ...p };
  }
  if (parsed.today && typeof parsed.today === 'object') {
    const t = parsed.today;
    for (const f of ['date', 'targetNew', 'doneNew', 'stats', 'queue']) {
      if (t[f] === undefined) repaired.push(`today.${f}`);
    }
    state.today = {
      ...emptyToday(typeof t.date === 'string' ? t.date : dateKey()),
      ...t,
      stats: { ...emptyStats(), ...(t.stats && typeof t.stats === 'object' ? t.stats : {}) },
      seenNew: Array.isArray(t.seenNew) ? t.seenNew : [],
      queue: Array.isArray(t.queue) ? t.queue.filter((c) => c && typeof c.wordId === 'string') : [],
      pendingRequeue: Array.isArray(t.pendingRequeue) ? t.pendingRequeue : [],
      wrongIds: Array.isArray(t.wrongIds) ? t.wrongIds : [],
    };
    if (typeof state.today.queuePos !== 'number') state.today.queuePos = 0;
    if (typeof state.today.doneNew !== 'number') state.today.doneNew = 0;
    if (typeof state.today.targetNew !== 'number') state.today.targetNew = 0;
  }
  state.history = Array.isArray(parsed.history)
    ? parsed.history.filter((h) => h && typeof h === 'object').slice(0, HISTORY_LIMIT)
    : [];

  let migrated = null;
  if (version && state.wordBankVersion !== version) {
    migrated = migrateState(state, words, version);
  }
  return { state, status: repaired.length ? 'repaired' : 'ok', migrated };
}

export function saveState(state, storage) {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function ensureToday(state, words, today = dateKey()) {
  if (state.today.date === today) {
    if (!state.today.targetNew) state.today.targetNew = computeTarget(state, words);
    return state;
  }
  if (state.today.date) {
    state.history.unshift({
      date: state.today.date,
      targetNew: state.today.targetNew,
      doneNew: state.today.doneNew,
      stats: { ...state.today.stats },
    });
    state.history = state.history.slice(0, HISTORY_LIMIT);
  }
  const fresh = emptyToday(today, computeTarget(state, words));
  state.today = fresh;
  return state;
}

export function buildQueue(state, words, { today = dateKey(), rng = Math.random } = {}) {
  const progress = state.progress;
  const active = words.filter((w) => progress[w.id] && !progress[w.id].retired);
  const byId = new Map(active.map((w) => [w.id, w]));
  const picked = new Set();
  const out = [];

  const push = (id, kind) => {
    if (!byId.has(id) || picked.has(id)) return;
    picked.add(id);
    out.push({ wordId: id, kind });
  };

  // 段 0:pendingRequeue 插到队首,沿用原 kind
  const snapshot = state.today.queue || [];
  for (const id of state.today.pendingRequeue || []) {
    const origin = snapshot.find((c) => c.wordId === id);
    push(id, origin ? origin.kind : KIND.REDO);
  }
  // 段 1:快照剩余
  for (const c of (state.today.queue || []).slice(state.today.queuePos || 0)) push(c.wordId, c.kind);
  // 段 2:到期补入
  const due = active
    .filter((w) => {
      const p = progress[w.id];
      return REVIEW_STAGES.includes(p.stage) && p.due && p.due <= today && !picked.has(w.id);
    })
    .sort((a, b) => progress[a.id].due.localeCompare(progress[b.id].due) || a.序号 - b.序号);
  for (const w of due) push(w.id, KIND.DUE);
  // 段 3:重学词
  const redo = active
    .filter((w) => {
      const p = progress[w.id];
      return p.everStudied && p.stage === STAGE.NEW && !picked.has(w.id);
    })
    .sort((a, b) => a.序号 - b.序号);
  for (const w of redo) push(w.id, KIND.REDO);
  // 段 4:新词
  const need = Math.max(0, (state.today.targetNew || 0) - (state.today.doneNew || 0));
  const fresh = active
    .filter((w) => {
      const p = progress[w.id];
      return !p.everStudied && p.stage === STAGE.NEW && !picked.has(w.id);
    })
    .sort((a, b) => a.序号 - b.序号)
    .slice(0, need);
  for (const w of fresh) push(w.id, KIND.NEW);
  // 段 5:轻复习抽查
  const pool = active.filter((w) => progress[w.id].stage === STAGE.LEARNED && !picked.has(w.id));
  for (const w of shuffle(pool, rng).slice(0, state.settings.lightCount)) push(w.id, KIND.LIGHT);

  return out;
}

export function answerCard(state, queue, pos, known, today = dateKey()) {
  const card = queue[pos];
  if (!card) return null;
  const prog = state.progress[card.wordId];
  if (!prog) return null;

  const firstEver = !prog.everStudied;
  const prevStage = prog.stage;
  state.today.stats.answers += 1;
  prog.lastSeen = today;

  if (firstEver && !state.today.seenNew.includes(card.wordId)) {
    state.today.seenNew.push(card.wordId);
    state.today.doneNew += 1;
  }

  let requeue = false;
  if (known) {
    state.today.stats.correct += 1;
    if (card.kind === KIND.NEW && firstEver && !prog.firstTryCorrect) {
      prog.firstTryCorrect = true;
      state.today.stats.firstTryCorrect += 1;
    }
    if (prog.stage < STAGE.LEARNED) prog.stage += 1;
    if (prog.stage === STAGE.IMMEDIATE || prog.stage === STAGE.SAME_DAY) prog.due = today;
    else if (prog.stage === STAGE.NEXT_DAY) prog.due = addDays(today, 1);
    else {
      prog.due = null;
      prog.poolEnteredAt = today;
    }
    prog.everStudied = true;
    requeue = prevStage === STAGE.NEW;
  } else {
    state.today.stats.wrong += 1;
    prog.wrongCount += 1;
    prog.stage = STAGE.NEW;
    prog.everStudied = true;
    prog.firstTryCorrect = false;
    prog.due = today;
    card.kind = KIND.REDO; // 答错归零后成为重学词
    if (!state.today.wrongIds.includes(card.wordId)) state.today.wrongIds.push(card.wordId);
    requeue = true;
  }

  // 作答后该卡离队;需要重排时再按规则插回
  queue.splice(pos, 1);
  if (requeue) {
    const remaining = queue.length;
    if (remaining === 0) {
      if (!state.today.pendingRequeue.includes(card.wordId)) state.today.pendingRequeue.push(card.wordId);
    } else if (remaining === 1) {
      queue.splice(pos, 0, card);
    } else {
      queue.splice(Math.min(pos + 1, remaining), 0, card);
    }
  }

  state.today.queuePos = pos;
  return card;
}

export function computeStats(state) {
  const { answers, correct, wrong, firstTryCorrect } = state.today.stats;
  return {
    answers,
    correct,
    wrong,
    firstTryCorrect,
    accuracy: answers ? correct / answers : null,
    doneNew: state.today.doneNew,
    targetNew: state.today.targetNew,
    wrongIds: state.today.wrongIds.slice(),
  };
}
