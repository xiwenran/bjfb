const test = require('node:test');
const assert = require('node:assert/strict');

const { allocateImportSchedule } = require('../src/scheduler-allocator.js');

function buildNoteFolders(topic, count) {
  return [{ topic, templates: Array.from({ length: count }, (_, index) => String(index + 1)) }];
}

function baseInput(overrides = {}) {
  return {
    seed: 'fixed-seed',
    noteFolders: buildNoteFolders('主题A', 1),
    accounts: { xiaohongshu_regular: ['账号1'], xiaohongshu_special: [], douyin: [] },
    accountGroups: { 账号1: '店铺A' },
    timeSlots: { regular: ['2026-07-16 15:01'], special: [] },
    coverageStrategy: 'minimum',
    ...overrides,
  };
}

test('同一素材允许跨平台复用，但同平台不复用', () => {
  const result = allocateImportSchedule(baseInput({
    seed: 'reuse',
    noteFolders: buildNoteFolders('教务类/家长会', 4),
    accounts: {
      xiaohongshu_regular: ['小雨', '甜甜'],
      xiaohongshu_special: [],
      douyin: ['小赵', '小茜'],
    },
    accountGroups: { 小雨: '教师店', 甜甜: '教师店', 小赵: '视频店', 小茜: '视频店' },
    timeSlots: { regular: ['2026-07-16 08:00 - 20:00'], special: [] },
    perAccountPerSlot: 2,
  }));
  const xhs = result.schedule.filter(item => item.platform === 'xiaohongshu').map(item => item.noteKey);
  const douyin = result.schedule.filter(item => item.platform === 'douyin').map(item => item.noteKey);
  assert.equal(new Set(xhs).size, xhs.length);
  assert.equal(new Set(douyin).size, douyin.length);
  assert.ok(douyin.some(noteKey => xhs.includes(noteKey)));
});

test('同账号与既有排期正好360分钟拒绝，361分钟通过', () => {
  const reservation = [{
    platform: 'xiaohongshu', account: '账号1', publishTime: '2026-07-16 09:00',
    topicKey: '旧主题', storeGroup: '店铺A',
  }];
  assert.throws(() => allocateImportSchedule(baseInput({
    timeSlots: { regular: ['2026-07-16 15:00'], special: [] },
    existingReservations: reservation,
  })), error => error.statusCode === 400 && /至少间隔 361 分钟/.test(error.message));

  const result = allocateImportSchedule(baseInput({ existingReservations: reservation }));
  assert.equal(result.schedule[0].publishTime, '2026-07-16 15:01');
  assert.equal(result.constraints.minSameAccountIntervalMinutes, 361);
});

test('同seed结果一致、窗口分层且全局分钟唯一', () => {
  const input = baseInput({
    seed: 'stratified',
    noteFolders: buildNoteFolders('主题A', 4),
    accounts: { xiaohongshu_regular: ['账号1', '账号2', '账号3', '账号4'], xiaohongshu_special: [], douyin: [] },
    accountGroups: { 账号1: '店铺A', 账号2: '店铺B', 账号3: '店铺C', 账号4: '店铺D' },
    timeSlots: { regular: ['2026-07-16 08:00 - 12:00'], special: [] },
  });
  const first = allocateImportSchedule(input);
  const second = allocateImportSchedule(input);
  assert.deepEqual(first, second);
  const minutes = first.schedule.map(item => item.publishTime).sort();
  assert.equal(new Set(minutes).size, minutes.length);
  assert.ok(minutes[0] < '2026-07-16 09:00');
  assert.ok(minutes.at(-1) >= '2026-07-16 11:00');
});

test('既有记录不占当前批全局分钟，但当前批内部同分钟仍拒绝', () => {
  const result = allocateImportSchedule(baseInput({
    accounts: { xiaohongshu_regular: ['账号2'], xiaohongshu_special: [], douyin: [] },
    accountGroups: { 账号2: '店铺B' },
    timeSlots: { regular: ['2026-07-16 10:00'], special: [] },
    existingReservations: [{
      platform: 'xiaohongshu', account: '账号1', publishTime: '2026-07-16 10:00',
      topicKey: '旧主题', storeGroup: '店铺A',
    }],
  }));
  assert.equal(result.schedule[0].publishTime, '2026-07-16 10:00');

  assert.throws(() => allocateImportSchedule(baseInput({
    noteFolders: buildNoteFolders('主题A', 2),
    accounts: { xiaohongshu_regular: ['账号1', '账号2'], xiaohongshu_special: [], douyin: [] },
    accountGroups: { 账号1: '店铺A', 账号2: '店铺B' },
    timeSlots: { regular: ['2026-07-16 10:00'], special: [] },
  })), error => error.statusCode === 400 && /唯一分钟/.test(error.message));
});

test('分钟容量不足或无法全排时抛400，不返回部分排期', () => {
  assert.throws(() => allocateImportSchedule(baseInput({
    noteFolders: buildNoteFolders('主题A', 3),
    accounts: { xiaohongshu_regular: ['账号1', '账号2', '账号3'], xiaohongshu_special: [], douyin: [] },
    accountGroups: { 账号1: '店铺A', 账号2: '店铺B', 账号3: '店铺C' },
    timeSlots: { regular: ['2026-07-16 09:00 - 09:01'], special: [] },
  })), error => error.statusCode === 400 && /唯一分钟不足/.test(error.message));

  assert.throws(() => allocateImportSchedule(baseInput({
    noteFolders: buildNoteFolders('主题A', 2),
    timeSlots: { regular: ['2026-07-16 09:00'], special: [] },
  })), error => error.statusCode === 400 && /无法安排全部笔记/.test(error.message));
});

test('不存在的日历日期不能被自动滚到下个月', () => {
  assert.throws(() => allocateImportSchedule(baseInput({
    timeSlots: { regular: ['2026-02-30 09:00'], special: [] },
  })), error => error.statusCode === 400 && /日期|发布时间/.test(error.message));
});

test('auto_space强制同店同主题跨账号361分钟且要求小红书店铺映射', () => {
  const common = baseInput({
    topicDecision: 'auto_space',
    noteFolders: buildNoteFolders('主题A', 2),
    accounts: { xiaohongshu_regular: ['账号1', '账号2'], xiaohongshu_special: [], douyin: [] },
    timeSlots: { regular: ['2026-07-16 09:00 - 10:00'], special: [] },
  });
  assert.throws(() => allocateImportSchedule({ ...common, accountGroups: { 账号1: '店铺A' } }), /缺少店铺组映射/);
  assert.throws(() => allocateImportSchedule({ ...common, accountGroups: { 账号1: '店铺A', 账号2: '店铺A' } }), error => (
    error.statusCode === 400 && /无法安排全部笔记/.test(error.message)
  ));
});

test('allow_conflicts只跳过跨账号主题间隔，不跳过同账号与全局分钟约束', () => {
  const allowed = allocateImportSchedule(baseInput({
    topicDecision: 'allow_conflicts',
    noteFolders: buildNoteFolders('主题A', 2),
    accounts: { xiaohongshu_regular: ['账号1', '账号2'], xiaohongshu_special: [], douyin: [] },
    accountGroups: { 账号1: '店铺A', 账号2: '店铺A' },
    timeSlots: { regular: ['2026-07-16 09:00 - 10:00'], special: [] },
  }));
  assert.equal(allowed.schedule.length, 2);
  assert.equal(new Set(allowed.schedule.map(item => item.publishTime)).size, 2);

  assert.throws(() => allocateImportSchedule(baseInput({
    topicDecision: 'allow_conflicts',
    timeSlots: { regular: ['2026-07-16 15:00'], special: [] },
    existingReservations: [{
      platform: 'xiaohongshu', account: '账号1', publishTime: '2026-07-16 09:00',
      topicKey: '主题A', storeGroup: '店铺A',
    }],
  })), /至少间隔 361 分钟/);
});
