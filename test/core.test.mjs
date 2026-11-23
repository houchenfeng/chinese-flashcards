import test from 'node:test';
import assert from 'node:assert/strict';
import { WORDS, WORD_BANK_VERSION } from '../words.js';
import {
  STAGE, KIND, STORAGE_KEY,
  createState, ensureToday, buildQueue, answerCard, computeStats,
  saveState, loadState, dateKey, addDays, migrateState, shuffle,
} from '../core.js';

const TODAY = '2026-11-23';
const NEXT = '2026-11-24';

function fresh(today = TODAY) {
  const state = createState(WORDS);
  ensureToday(state, WORDS, today);
  return state;
}

function memStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function setStage(state, id, stage, due = null) {
  state.progress[id].stage = stage;
  state.progress[id].due = due;
  state.progress[id].everStudied = true;
}

/** 模拟进入学习页:构建今日队列快照 */
function enterStudy(state, today = TODAY) {
  state.today.queue = buildQueue(state, WORDS, { today });
  state.today.queuePos = 0;
  return state.today.queue;
}

test('AC-01 词库完整性:字段齐全、拼音带声调、例句英文 3-12 词', () => {
  assert.equal(WORDS.length, 10);
  const required = ['id', '序号', '汉字', '拼音', '英文释义', '词性', '例句', '例句拼音', '例句英文'];
  const tones = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]/;
  for (const w of WORDS) {
    for (const f of required) {
      assert.ok(w[f] !== undefined && String(w[f]).trim() !== '', `${w.id} 缺字段 ${f}`);
    }
    assert.ok(tones.test(w.拼音), `${w.id} 拼音缺声调: ${w.拼音}`);
    const en = w.例句英文.replace(/[—–-]/g, ' ').split(/\s+/).filter(Boolean);
    assert.ok(en.length >= 3 && en.length <= 12, `${w.id} 例句英文 ${en.length} 词`);
    assert.equal(w.场景, '打招呼');
  }
  assert.deepEqual(WORDS.map((w) => w.序号), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('AC-02 初始状态:全部 stage=0 且 everStudied=false,队列只含 new 且按序号升序', () => {
  const state = fresh();
  for (const w of WORDS) {
    assert.equal(state.progress[w.id].stage, STAGE.NEW);
    assert.equal(state.progress[w.id].everStudied, false);
  }
  const queue = enterStudy(state);
  assert.equal(queue.length, 10);
  assert.ok(queue.every((c) => c.kind === KIND.NEW));
  assert.deepEqual(queue.map((c) => c.wordId), WORDS.map((w) => w.id));
});

test('AC-03 斩过推进:S0→S1 隔一张重排,S1→S2 due=今天,S2→S3 due=明天,S3→S4 进池', () => {
  const s0 = fresh();
  const q0 = enterStudy(s0);
  answerCard(s0, q0, 0, true, TODAY);
  assert.equal(s0.progress.w001.stage, STAGE.IMMEDIATE);
  assert.equal(s0.progress.w001.due, TODAY);
  assert.equal(q0.length, 10, '取出再插回,总数不变');
  assert.equal(q0[0].wordId, 'w002', '下一张是 w002');
  assert.equal(q0[1].wordId, 'w001', 'w001 隔一张再出');
  assert.equal(s0.today.queuePos, 0);

  const s1 = fresh();
  setStage(s1, 'w001', STAGE.IMMEDIATE, TODAY);
  const q1 = enterStudy(s1);
  answerCard(s1, q1, 0, true, TODAY);
  assert.equal(s1.progress.w001.stage, STAGE.SAME_DAY);
  assert.equal(s1.progress.w001.due, TODAY);

  const s2 = fresh();
  setStage(s2, 'w001', STAGE.SAME_DAY, TODAY);
  const q2 = enterStudy(s2);
  answerCard(s2, q2, 0, true, TODAY);
  assert.equal(s2.progress.w001.stage, STAGE.NEXT_DAY);
  assert.equal(s2.progress.w001.due, addDays(TODAY, 1));

  const s3 = fresh();
  setStage(s3, 'w001', STAGE.NEXT_DAY, TODAY);
  const q3 = enterStudy(s3);
  answerCard(s3, q3, 0, true, TODAY);
  assert.equal(s3.progress.w001.stage, STAGE.LEARNED);
  assert.equal(s3.progress.w001.due, null);
  assert.equal(s3.progress.w001.poolEnteredAt, TODAY);
});

test('AC-04 答错归零:任意档答错回到 S0、everStudied=true,记入 wrongIds 与 stats.wrong', () => {
  const state = fresh();
  setStage(state, 'w001', STAGE.NEXT_DAY, '2026-11-22');
  const queue = enterStudy(state);
  answerCard(state, queue, 0, false, TODAY);

  assert.equal(state.progress.w001.stage, STAGE.NEW);
  assert.equal(state.progress.w001.everStudied, true);
  assert.equal(state.progress.w001.wrongCount, 1);
  assert.equal(state.today.stats.wrong, 1);
  assert.deepEqual(state.today.wrongIds, ['w001']);
  assert.equal(queue[1].wordId, 'w001', '答错的卡隔一张再出');
});

test('AC-05 统计口径:正确率、首次答对只算真新词、doneNew 按 seenNew 去重', () => {
  const state = fresh();
  const queue = enterStudy(state);

  answerCard(state, queue, 0, true, TODAY);
  assert.equal(state.today.stats.answers, 1);
  assert.equal(state.today.stats.correct, 1);
  assert.equal(state.today.stats.firstTryCorrect, 1);
  assert.equal(state.today.doneNew, 1);

  answerCard(state, queue, 0, false, TODAY);
  assert.equal(state.today.stats.answers, 2);
  assert.equal(state.today.stats.wrong, 1);
  assert.equal(state.today.doneNew, 2, '真新词首学即计入,同一词不重复计');

  const s = computeStats(state);
  assert.equal(s.accuracy, 0.5);
  assert.equal(computeStats(fresh()).accuracy, null, '分母为 0 时正确率为 null');
});

test('AC-06 持久化:保存-读取往返一致,跨日 ensureToday 归档重开', () => {
  const storage = memStorage();
  const state = fresh();
  const queue = enterStudy(state);
  answerCard(state, queue, 0, true, TODAY);
  state.settings.dailyNew = 20;
  saveState(state, storage);

  assert.ok(storage.getItem(STORAGE_KEY), '应写入 localStorage');

  const { state: loaded, status } = loadState(storage, WORDS, { version: WORD_BANK_VERSION });
  assert.equal(status, 'ok');
  assert.equal(loaded.progress.w001.stage, STAGE.IMMEDIATE);
  assert.equal(loaded.today.stats.answers, 1);
  assert.equal(loaded.today.doneNew, 1);
  assert.equal(loaded.settings.dailyNew, 20);

  ensureToday(loaded, WORDS, NEXT);
  assert.equal(loaded.today.date, NEXT);
  assert.equal(loaded.today.stats.answers, 0);
  assert.equal(loaded.today.doneNew, 0);
  assert.equal(loaded.today.queue.length, 0);
  assert.equal(loaded.history.length, 1);
  assert.equal(loaded.history[0].date, TODAY);
  assert.equal(loaded.history[0].stats.answers, 1);
});

test('AC-07 队列构建:到期按 due 升序、新词按序号、抽查只从池中抽、按 wordId 去重', () => {
  const state = fresh();
  setStage(state, 'w001', STAGE.SAME_DAY, '2026-11-22');
  setStage(state, 'w002', STAGE.NEXT_DAY, TODAY);
  setStage(state, 'w003', STAGE.LEARNED, null);

  const queue = buildQueue(state, WORDS, { today: TODAY });
  assert.deepEqual(queue[0], { wordId: 'w001', kind: KIND.DUE });
  assert.deepEqual(queue[1], { wordId: 'w002', kind: KIND.DUE });

  const news = queue.filter((c) => c.kind === KIND.NEW).map((c) => c.wordId);
  assert.deepEqual(news, ['w004', 'w005', 'w006', 'w007', 'w008', 'w009', 'w010']);

  const lights = queue.filter((c) => c.kind === KIND.LIGHT);
  assert.equal(lights.length, 1);
  assert.equal(lights[0].wordId, 'w003');

  const ids = queue.map((c) => c.wordId);
  assert.equal(new Set(ids).size, ids.length, '同一词不得重复出现');

  const kinds = queue.map((c) => c.kind);
  assert.ok(kinds.indexOf(KIND.LIGHT) > kinds.lastIndexOf(KIND.NEW), '顺序应为 到期 → 新词 → 抽查');
});

test('AC-08 词库学完:无真新词时新词段为空,队列仍含抽查', () => {
  const state = fresh();
  for (const w of WORDS) setStage(state, w.id, STAGE.LEARNED, null);
  const queue = buildQueue(state, WORDS, { today: TODAY });
  assert.equal(queue.filter((c) => c.kind === KIND.NEW).length, 0);
  assert.equal(queue.length, 10);
  assert.ok(queue.every((c) => c.kind === KIND.LIGHT));
});

test('AC-09 新词 vs 重学词:答错归零的词进重学段,不计入 doneNew 与 firstTryCorrect', () => {
  const state = fresh();
  const queue = enterStudy(state);
  answerCard(state, queue, 0, false, TODAY);

  assert.equal(state.progress.w001.everStudied, true);
  assert.equal(state.today.doneNew, 1, '首次首学已计入');
  assert.equal(state.today.stats.firstTryCorrect, 0, '答错不计首次答对');

  const requeued = state.today.queue.find((c) => c.wordId === 'w001');
  assert.equal(requeued.kind, KIND.REDO, '答错后成为重学卡');

  state.today.doneNew = 0;
  state.today.seenNew = [];
  state.today.queue = [];
  state.today.queuePos = 0;
  const rebuilt = buildQueue(state, WORDS, { today: TODAY });
  const redo = rebuilt.filter((c) => c.kind === KIND.REDO).map((c) => c.wordId);
  assert.deepEqual(redo, ['w001'], '答错归零的词进重学段');
  assert.equal(rebuilt.filter((c) => c.kind === KIND.NEW).length, 9, '不再算真新词');
});

test('AC-10 S2 当天补入:退出后重新进入,当日到期的 S2 词补入队列', () => {
  const state = fresh();
  setStage(state, 'w001', STAGE.IMMEDIATE, TODAY);
  const queue = enterStudy(state);
  answerCard(state, queue, 0, true, TODAY);
  assert.equal(state.progress.w001.stage, STAGE.SAME_DAY, 'S1 斩过进入 S2');
  assert.equal(state.progress.w001.due, TODAY, 'S2 当天到期');

  const reopened = buildQueue(state, WORDS, { today: TODAY });
  assert.ok(
    reopened.some((c) => c.wordId === 'w001' && c.kind === KIND.DUE),
    '重新进入时,当日到期的 S2 词补入到期段',
  );
});

test('AC-11 重排边界:剩余 1 张紧接再出,队列只剩 1 张写入 pendingRequeue 并插到队首', () => {
  const state = fresh();
  const queue = enterStudy(state);
  queue.length = 2;
  queue[1] = { wordId: 'w002', kind: KIND.NEW };
  answerCard(state, queue, 0, false, TODAY);
  assert.equal(queue[0].wordId, 'w001', '只剩 1 张时紧接当前卡再出');

  const only = fresh();
  only.today.queue = [{ wordId: 'w001', kind: KIND.NEW }];
  only.today.queuePos = 0;
  answerCard(only, only.today.queue, 0, false, TODAY);
  assert.deepEqual(only.today.pendingRequeue, ['w001'], '只剩这一张时顺延到 pendingRequeue');

  const reopened = buildQueue(only, WORDS, { today: TODAY });
  assert.equal(reopened[0].wordId, 'w001', '下次进入插到队首');
  assert.equal(reopened[0].kind, KIND.REDO);
});

test('AC-12 重复作答不重复计数:同一张卡两次作答只计一次首学,kind 不变', () => {
  const state = fresh();
  const queue = enterStudy(state);
  answerCard(state, queue, 0, true, TODAY);
  const firstDone = state.today.doneNew;
  const firstCorrect = state.today.stats.firstTryCorrect;
  const card = state.today.queue.find((c) => c.wordId === 'w001');
  answerCard(state, queue, queue.indexOf(card), true, TODAY);
  assert.equal(state.today.doneNew, firstDone, 'doneNew 不重复计');
  assert.equal(state.today.stats.firstTryCorrect, firstCorrect, '首次答对不重复计');
  assert.equal(card.kind, KIND.NEW, '重排后 kind 不变');
});

test('AC-13 结构异常容错:缺字段逐项补默认值,非法 JSON 回退空状态', () => {
  const storage = memStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, progress: { w001: { stage: 2 } } }));
  const { state, status } = loadState(storage, WORDS, { version: WORD_BANK_VERSION });
  assert.equal(status, 'repaired');
  assert.equal(state.progress.w001.stage, 2, '已有进度保留');
  assert.equal(state.progress.w001.everStudied, false, '缺失字段补默认值');
  assert.equal(state.today.stats.answers, 0);
  assert.equal(state.settings.dailyNew, 30);
  assert.equal(state.history.length, 0);

  storage.setItem(STORAGE_KEY, '{ not json');
  const broken = loadState(storage, WORDS, { version: WORD_BANK_VERSION });
  assert.equal(broken.status, 'corrupted');
  assert.equal(broken.state.today.stats.answers, 0, '非法 JSON 回退空状态');
});

test('AC-14 词库迁移:新增 id 不影响旧进度,失效 id 被跳过,被移除词不再进队列但进度保留', () => {
  const state = fresh();
  state.progress.w001.stage = STAGE.LEARNED;
  state.progress.w010.retired = true;

  const extra = [...WORDS, { ...WORDS[0], id: 'w011', 序号: 11, 汉字: '新词' }];
  const { added, removed } = migrateState(state, extra, 'v2');
  assert.deepEqual(added, ['w011']);
  assert.deepEqual(removed, []);

  const queue = buildQueue(state, extra, { today: TODAY });
  assert.ok(queue.some((c) => c.wordId === 'w011'), '新词进入新词段');
  assert.ok(!queue.some((c) => c.wordId === 'w010'), '已移除的词不再进队列');
  assert.equal(state.progress.w001.stage, STAGE.LEARNED, '旧进度不受影响');
  assert.equal(state.progress.w010.retired, true, '被移除词标记 retired,进度保留');

  const stale = fresh();
  stale.today.queue = [{ wordId: 'w999', kind: KIND.NEW }];
  stale.today.queuePos = 0;
  const rebuilt = buildQueue(stale, WORDS, { today: TODAY });
  assert.ok(!rebuilt.some((c) => c.wordId === 'w999'), '快照中的失效 id 被跳过');
});

test('辅助:日期工具与随机注入', () => {
  assert.equal(addDays('2026-11-23', 1), '2026-11-24');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.match(dateKey(new Date(2026, 0, 5)), /^2026-01-05$/);
  const seeded = shuffle([1, 2, 3, 4, 5], () => 0.5);
  assert.equal(seeded.length, 5);
  assert.deepEqual([...seeded].sort(), [1, 2, 3, 4, 5]);
});
