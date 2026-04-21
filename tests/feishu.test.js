const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAttachmentSortKey,
  orderAttachmentsForDownload,
} = require('../src/feishu.js');

test('parseAttachmentSortKey supports ascii and full-width duplicate suffixes', () => {
  assert.deepEqual(parseAttachmentSortKey('0.png'), [0, -1]);
  assert.deepEqual(parseAttachmentSortKey('0(1).png'), [0, 1]);
  assert.deepEqual(parseAttachmentSortKey('0（2）.png'), [0, 2]);
  assert.deepEqual(parseAttachmentSortKey('0 (3).png'), [0, 3]);
});

test('orderAttachmentsForDownload sorts full-width duplicate suffixes before later pages', () => {
  const attachments = [
    { name: '0（3）.png' },
    { name: '1.png' },
    { name: '0.png' },
    { name: '0（1）.png' },
    { name: '0（2）.png' },
  ];

  const ordered = orderAttachmentsForDownload(attachments).map(item => item.name);

  assert.deepEqual(ordered, [
    '0.png',
    '0（1）.png',
    '0（2）.png',
    '0（3）.png',
    '1.png',
  ]);
});

test('orderAttachmentsForDownload keeps non-numeric names in original relative order', () => {
  const attachments = [
    { name: '封面 (3).png' },
    { name: '2.png' },
    { name: '课程封面_11.png' },
    { name: '10.png' },
  ];

  const ordered = orderAttachmentsForDownload(attachments).map(item => item.name);

  assert.deepEqual(ordered, [
    '2.png',
    '10.png',
    '封面 (3).png',
    '课程封面_11.png',
  ]);
});
