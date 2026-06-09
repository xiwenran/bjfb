const test = require('node:test');
const assert = require('node:assert/strict');

const { allocateImportSchedule } = require('../src/scheduler-allocator.js');

function buildNoteFolders(topic, count) {
  return [{
    topic,
    templates: Array.from({ length: count }, (_, idx) => String(idx + 1)),
  }];
}

test('allocateImportSchedule allows note reuse across platforms but not within the same platform', () => {
  const result = allocateImportSchedule({
    noteFolders: buildNoteFolders('教务类/家长会', 8),
    accounts: {
      xiaohongshu_regular: ['小雨老师', '甜甜老师', '浅浅', '芝士就是力量'],
      douyin: ['小赵老师', '小茜老师', '木子李老师'],
    },
    timeSlots: {
      regular: ['2026-06-07 09:00', '2026-06-08 09:00'],
      special: [],
    },
    perAccountPerSlot: 1,
    coverageStrategy: 'minimum',
  });

  assert.equal(result.stats.scheduledCount, 14);
  assert.equal(result.schedule.filter(item => item.platform === 'xiaohongshu').length, 8);
  assert.equal(result.schedule.filter(item => item.platform === 'douyin').length, 6);
  assert.deepEqual(result.stats.violations, []);

  const xhsNoteKeys = result.schedule
    .filter(item => item.platform === 'xiaohongshu')
    .map(item => item.noteKey);
  const dyNoteKeys = result.schedule
    .filter(item => item.platform === 'douyin')
    .map(item => item.noteKey);

  assert.equal(new Set(xhsNoteKeys).size, xhsNoteKeys.length);
  assert.equal(new Set(dyNoteKeys).size, dyNoteKeys.length);
  assert.ok(dyNoteKeys.some(noteKey => xhsNoteKeys.includes(noteKey)));
});
