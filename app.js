import { WORDS, WORD_BANK_VERSION } from './words.js';
import * as core from './core.js';

const $ = (sel) => document.querySelector(sel);
const wordById = new Map(WORDS.map((w) => [w.id, w]));

let state = null;
let revealed = false;
let current = null;
let lockUntil = 0;
let sessionActive = false;
let sessionAnswered = 0;
let saveFailed = false;

function makeStorage() {
  return {
    getItem(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        window.localStorage.setItem(key, value);
        if (saveFailed) {
          saveFailed = false;
          $('#save-warn').hidden = true;
        }
      } catch {
        saveFailed = true;
        $('#save-warn').hidden = false;
        toast('进度未能保存,本机可能禁用了存储');
      }
    },
  };
}

const storage = makeStorage();

function save() {
  try {
    core.saveState(state, storage);
  } catch {
    saveFailed = true;
    $('#save-warn').hidden = false;
  }
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2200);
}

function fmtDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(y, m - 1, d).getDay()];
  return `${m}月${d}日 ${wd}`;
}

function speak(text, slow = false) {
  if (!('speechSynthesis' in window)) {
    toast('本设备不支持语音合成');
    return;
  }
  try {
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = slow ? 0.6 : 0.95;
    const voices = synth.getVoices();
    const zh = voices.find((v) => /^zh/i.test(v.lang));
    if (zh) u.voice = zh;
    else toast('本机无中文语音包');
    synth.speak(u);
  } catch {
    toast('语音播放失败');
  }
}

function show(view) {
  for (const v of ['#view-today', '#view-study', '#view-summary']) $(v).hidden = v !== view;
  window.scrollTo(0, 0);
}

function queuePreview() {
  if (sessionActive && state.today.queuePos < state.today.queue.length) {
    return state.today.queue.slice(state.today.queuePos);
  }
  return core.buildQueue(state, WORDS, { today: core.dateKey() });
}

function countKinds(queue) {
  const counts = { new: 0, redo: 0, due: 0, light: 0 };
  const seen = new Set();
  for (const c of queue) {
    if (seen.has(c.wordId)) continue;
    seen.add(c.wordId);
    counts[c.kind] = (counts[c.kind] || 0) + 1;
  }
  return counts;
}

function renderToday() {
  const today = core.dateKey();
  const preview = queuePreview();
  const counts = countKinds(preview);
  const target = state.today.targetNew || 0;
  const done = state.today.doneNew;

  $('#today-date').textContent = fmtDate(today);
  $('#goal-title').textContent = `今日目标 ${target} 词`;
  $('#done-num').textContent = done;
  $('#done-total').textContent = target;
  $('#done-bar').style.width = `${target ? Math.min(100, (done / target) * 100) : 0}%`;
  $('#due-chip').textContent = `待复习 ${counts.due}`;
  $('#light-chip').textContent = `轻复习 ${counts.light}`;
  $('#q-new').textContent = counts.new;
  $('#q-redo').textContent = counts.redo;
  $('#q-due').textContent = counts.due;
  $('#q-light').textContent = counts.light;

  const learned = WORDS.filter((w) => state.progress[w.id].stage === core.STAGE.LEARNED).length;
  $('#total-progress').textContent = `总进度 ${learned} / ${WORDS.length} 词`;

  const btn = $('#start-btn');
  if (preview.length) {
    btn.disabled = false;
    btn.textContent = state.today.stats.answers ? '继续学习' : '开始学习';
  } else {
    btn.disabled = true;
    const freshLeft = WORDS.some((w) => {
      const p = state.progress[w.id];
      return p && !p.retired && !p.everStudied && p.stage === core.STAGE.NEW;
    });
    btn.textContent = freshLeft ? '今日新词已学完(未满目标)' : '今日已完成,明天见';
  }
  $('#summary-link').hidden = !state.today.finishedAt;

  for (const b of $('#seg-daily').children) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.v) === state.settings.dailyNew));
  }
  for (const b of $('#seg-rate').children) {
    b.setAttribute('aria-pressed', String(b.dataset.v === state.settings.rate));
  }
  $('#sw-autospeak').setAttribute('aria-pressed', String(state.settings.autoSpeak));
  $('#save-warn').hidden = !saveFailed;
}

function renderCard() {
  const card = state.today.queue[state.today.queuePos];
  current = card ? wordById.get(card.wordId) : null;
  revealed = false;
  if (!current) return;

  $('#study-counter').textContent = `${Math.min(sessionAnswered + 1, state.today.queue.length)} / ${state.today.queue.length}`;
  $('#card-hanzi').textContent = current.汉字;
  $('#card-hint').hidden = false;
  $('#card-back').hidden = true;
  $('#btn-again').disabled = true;
  $('#btn-known').disabled = true;
}

function reveal() {
  if (revealed || !current) return;
  revealed = true;
  $('#card-hint').hidden = true;
  $('#card-back').hidden = false;
  $('#card-pinyin').textContent = current.拼音;
  $('#card-pos').textContent = current.词性;
  $('#card-meaning').textContent = current.英文释义;
  $('#ex-zh').textContent = current.例句;
  $('#ex-py').textContent = current.例句拼音;
  $('#ex-en').textContent = current.例句英文;
  $('#btn-again').disabled = false;
  $('#btn-known').disabled = false;
  if (state.settings.autoSpeak) speak(current.汉字, state.settings.rate === 'slow');
}

function checkNewDay() {
  const today = core.dateKey();
  if (state.today.date === today) return false;
  core.ensureToday(state, WORDS, today);
  sessionActive = false;
  save();
  show('#view-today');
  renderToday();
  toast('新的一天,进度已重置');
  return true;
}

function startStudy() {
  if (checkNewDay()) return;
  const today = core.dateKey();
  state.today.queue = core.buildQueue(state, WORDS, { today });
  state.today.queuePos = 0;
  state.today.pendingRequeue = [];
  state.today.startedAt = state.today.startedAt || new Date().toISOString();
  sessionActive = true;
  sessionAnswered = 0;
  save();
  show('#view-study');
  renderCard();
}

function exitStudy() {
  sessionActive = false;
  show('#view-today');
  renderToday();
}

function finishStudy() {
  state.today.finishedAt = new Date().toISOString();
  sessionActive = false;
  save();
  if (state.today.stats.answers > 0 && state.today.doneNew >= state.today.targetNew) {
    renderSummary();
    show('#view-summary');
  } else {
    show('#view-today');
    renderToday();
  }
}

function answer(known) {
  if (!revealed || !current) return;
  const now = Date.now();
  if (now < lockUntil) return;
  lockUntil = now + 250;
  if (checkNewDay()) return;
  core.answerCard(state, state.today.queue, state.today.queuePos, known, core.dateKey());
  sessionAnswered += 1;
  save();
  if (state.today.queuePos >= state.today.queue.length) {
    finishStudy();
    return;
  }
  renderCard();
}

function renderSummary() {
  const s = core.computeStats(state);
  $('#sum-done').textContent = `${s.doneNew} / ${s.targetNew} 词`;
  $('#sum-sub').textContent = `共作答 ${s.answers} 次`;
  $('#sum-acc').textContent = s.accuracy === null ? '—' : `${Math.round(s.accuracy * 100)}%`;
  $('#sum-first').textContent = `${s.firstTryCorrect}`;
  $('#sum-wrong').textContent = `${s.wrong}`;

  const list = $('#sum-wrong-list');
  list.innerHTML = '';
  if (!state.today.wrongIds.length) {
    list.innerHTML = '<div class="muted">今天没有答错的词</div>';
  } else {
    for (const id of state.today.wrongIds) {
      const w = wordById.get(id);
      if (!w) continue;
      const div = document.createElement('div');
      div.className = 'wrong-item';
      div.innerHTML = `<div class="row"><b>${w.汉字}</b><span class="muted">${w.拼音}</span></div>
        <div class="muted" style="font-size:14px">${w.英文释义}</div>`;
      list.appendChild(div);
    }
  }
}

$('#start-btn').addEventListener('click', startStudy);
$('#summary-link').addEventListener('click', () => {
  renderSummary();
  show('#view-summary');
});
$('#close-study').addEventListener('click', exitStudy);
$('#btn-tomorrow').addEventListener('click', () => {
  show('#view-today');
  renderToday();
});
$('#flash').addEventListener('click', reveal);
$('#btn-again').addEventListener('click', (e) => { e.currentTarget.blur(); answer(false); });
$('#btn-known').addEventListener('click', (e) => { e.currentTarget.blur(); answer(true); });
$('#speak-word').addEventListener('click', (e) => { e.currentTarget.blur(); if (current) speak(current.汉字); });
$('#speak-slow').addEventListener('click', (e) => { e.currentTarget.blur(); if (current) speak(current.汉字, true); });
$('#speak-example').addEventListener('click', (e) => { e.currentTarget.blur(); if (current) speak(current.例句); });

$('#seg-daily').addEventListener('click', (e) => {
  const v = Number(e.target.dataset.v);
  if (!v) return;
  state.settings.dailyNew = v;
  save();
  renderToday();
  toast(`每日新词数改为 ${v},明日生效`);
});
$('#seg-rate').addEventListener('click', (e) => {
  const v = e.target.dataset.v;
  if (!v) return;
  state.settings.rate = v;
  save();
  renderToday();
});
$('#sw-autospeak').addEventListener('click', (e) => {
  state.settings.autoSpeak = !state.settings.autoSpeak;
  save();
  renderToday();
});

document.addEventListener('keydown', (e) => {
  if ($('#view-study').hidden) return;
  if (e.repeat) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.isContentEditable)) return;
  if (e.key === ' ') {
    e.preventDefault();
    reveal();
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    answer(true);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    answer(false);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    exitStudy();
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

const loaded = core.loadState(storage, WORDS, { version: WORD_BANK_VERSION });
state = loaded.state;
core.ensureToday(state, WORDS, core.dateKey());
save();

if (loaded.status === 'corrupted') {
  toast('进度数据已损坏,已重置');
} else if (loaded.status === 'repaired') {
  toast('进度数据已修复');
}

const migrated = loaded.migrated;
if (migrated && migrated.removed.length) {
  toast(`有 ${migrated.removed.length} 个词已从词库移除,它们的进度已保留但不会再出现`);
} else if (migrated && migrated.added.length) {
  toast('词库已更新');
}

renderToday();
