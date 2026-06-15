const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePublishedEntry,
  createSubmittedEntry,
  markEntryObservedPublished,
  shouldKeepEntryForPendingStatus,
  MIN_SAME_ACCOUNT_INTERVAL_MINUTES,
  MIN_SAME_ACCOUNT_INTERVAL_MS,
  findSameAccountIntervalViolations,
  getRecordPlatformAccounts,
} = require('../src/publish-guard.js');

test('normalizePublishedEntry upgrades legacy boolean values', () => {
  const now = Date.parse('2026-04-02T10:00:00.000Z');
  const entry = normalizePublishedEntry(true, now);

  assert.equal(typeof entry, 'object');
  assert.equal(entry.submittedAt, '2026-04-02T10:00:00.000Z');
  assert.equal(entry.observedPublishedAt, null);
});

test('recent pending status keeps the dedupe marker after a fresh submission', () => {
  const entry = createSubmittedEntry(Date.parse('2026-04-02T10:00:00.000Z'));
  const keep = shouldKeepEntryForPendingStatus(
    entry,
    Date.parse('2026-04-02T10:00:30.000Z'),
    2 * 60 * 1000
  );

  assert.equal(keep, true);
});

test('pending status after an observed published state should allow a manual republish', () => {
  const entry = markEntryObservedPublished(
    createSubmittedEntry(Date.parse('2026-04-02T10:00:00.000Z')),
    Date.parse('2026-04-02T10:01:00.000Z')
  );

  const keep = shouldKeepEntryForPendingStatus(
    entry,
    Date.parse('2026-04-02T10:01:30.000Z'),
    2 * 60 * 1000
  );

  assert.equal(keep, false);
});

test('old pending status stops keeping the dedupe marker after the guard window', () => {
  const entry = createSubmittedEntry(Date.parse('2026-04-02T10:00:00.000Z'));
  const keep = shouldKeepEntryForPendingStatus(
    entry,
    Date.parse('2026-04-02T10:05:00.000Z'),
    2 * 60 * 1000
  );

  assert.equal(keep, false);
});

test('publish guard exports the 6 hour hard interval', () => {
  assert.equal(MIN_SAME_ACCOUNT_INTERVAL_MINUTES, 360);
  assert.equal(MIN_SAME_ACCOUNT_INTERVAL_MS, 21600000);
});

test('findSameAccountIntervalViolations blocks same platform and same account within 6 hours', () => {
  const violations = findSameAccountIntervalViolations([
    {
      noteKey: 'a',
      publishTime: '2026-06-15 10:00',
      xiaohongshuAccount: '浅浅',
      douyinAccount: '',
    },
    {
      noteKey: 'b',
      publishTime: '2026-06-15 15:59',
      xiaohongshuAccount: '浅浅',
      douyinAccount: '',
    },
  ], {
    getPlatformAccounts: record => getRecordPlatformAccounts(record),
    getLabel: record => record.noteKey,
  });

  assert.equal(violations.length, 1);
  assert.equal(violations[0].platformLabel, '小红书');
  assert.equal(violations[0].account, '浅浅');
  assert.equal(violations[0].previousLabel, 'a');
  assert.equal(violations[0].nextLabel, 'b');
});

test('findSameAccountIntervalViolations keeps platforms independent', () => {
  const violations = findSameAccountIntervalViolations([
    {
      noteKey: 'xhs',
      publishTime: '2026-06-15 10:00',
      xiaohongshuAccount: '同名账号',
      douyinAccount: '',
    },
    {
      noteKey: 'dy',
      publishTime: '2026-06-15 10:10',
      xiaohongshuAccount: '',
      douyinAccount: '同名账号',
    },
  ], {
    getPlatformAccounts: record => getRecordPlatformAccounts(record),
    getLabel: record => record.noteKey,
  });

  assert.deepEqual(violations, []);
});
