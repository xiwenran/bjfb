const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePublishedEntry,
  createSubmittedEntry,
  markEntryObservedPublished,
  shouldKeepEntryForPendingStatus,
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
