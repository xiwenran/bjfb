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
  assert.deepEqual(parseAttachmentSortKey('1.2.png'), [1, 2]);
  assert.deepEqual(parseAttachmentSortKey('10.png'), [10, -1]);
});

test('parseAttachmentSortKey rejects digit-prefixed but non-page filenames (Codex 对抗性审查)', () => {
  // 这些"看起来以数字开头但不是编号页"的文件名应当返回 null，让它们保留原顺序，
  // 而不是被排到 1.png/2.png 等真正编号页前面。
  assert.equal(parseAttachmentSortKey('20260422-cover.png'), null, '日期前缀');
  assert.equal(parseAttachmentSortKey('1 封面.png'), null, '数字+空格+中文');
  assert.equal(parseAttachmentSortKey('12abc.png'), null, '数字+字母混合');
  assert.equal(parseAttachmentSortKey('1_cover.png'), null, '数字+下划线');
  assert.equal(parseAttachmentSortKey('课程封面_11.png'), null, '中文开头');
  assert.equal(parseAttachmentSortKey('封面 (3).png'), null, '中文+括号子序号');
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

test('parseAttachmentSortKey supports bare parenthesized numbers and dash/underscore sub-index', () => {
  assert.deepEqual(parseAttachmentSortKey('(7).jpg'), [7, -1]);
  assert.deepEqual(parseAttachmentSortKey('（12）.jpg'), [12, -1]);
  assert.deepEqual(parseAttachmentSortKey('1-2.png'), [1, 2]);
  assert.deepEqual(parseAttachmentSortKey('1_2.png'), [1, 2]);
  assert.equal(parseAttachmentSortKey('(封面).jpg'), null);
});

test('orderAttachmentsForDownload ignores the 12-hex import prefix even when it is all digits', () => {
  // 2026-10-08 真实事故：7.jpg 的随机前缀全是数字，被排到封面前面当首图发出。
  const names = [
    '243e0f616fae_0.jpg', 'b606c1282b11_1.jpg', '88451134a416_2.jpg', '70506579dd92_3.jpg',
    '8715ae1eb813_4.jpg', '48b5e2bafc2a_5.jpg', '5237690703ed_6.jpg', '435650296811_7.jpg',
    '53a280b63bc3_8.jpg', 'a0af61506f1a_9.jpg', '3c88915251c7_10.jpg', '6e847257bd1a_11.jpg',
    '74ad5d947c3f_12.jpg', '087af8e52bcb_13.jpg', 'f8dcae94178d_14.jpg',
  ];
  const shuffled = [...names].reverse().map(name => ({ name, file_token: `t_${name}` }));
  const ordered = orderAttachmentsForDownload(shuffled);
  assert.deepEqual(ordered.map(item => item.name), names, '按前缀后的序号排，且返回原始文件名');
  assert.equal(ordered[0].file_token, 't_243e0f616fae_0.jpg');

  const feishuOrder = names.map(name => ({ name }));
  assert.deepEqual(orderAttachmentsForDownload(feishuOrder).map(item => item.name), names);
});

test('orderAttachmentsForDownload sorts bare parenthesized numbers numerically', () => {
  const names = ['(7).jpg', '(2).jpg', '(10).jpg', '(1).jpg'];
  const ordered = orderAttachmentsForDownload(names.map(name => ({ name }))).map(item => item.name);
  assert.deepEqual(ordered, ['(1).jpg', '(2).jpg', '(7).jpg', '(10).jpg']);
});

test('orderAttachmentsForDownload sorts a uniform name template by its number', () => {
  const cases = [
    ['幻灯片10.PNG', '幻灯片2.PNG', '幻灯片1.PNG'],
    ['Slide3.png', 'Slide1.png', 'Slide2.png'],
    ['IMG_0012.jpg', 'IMG_0003.jpg', 'IMG_0010.jpg'],
    ['课件.003.png', '课件.001.png', '课件.002.png'],
    ['封面 (3).png', '封面 (1).png', '封面 (2).png'],
  ];
  for (const names of cases) {
    const ordered = orderAttachmentsForDownload(names.map(name => ({ name }))).map(item => item.name);
    const expected = [...names].sort((a, b) => Number(a.match(/(\d+)\D*$/)[1]) - Number(b.match(/(\d+)\D*$/)[1]));
    assert.deepEqual(ordered, expected, names.join(','));
  }
});

test('orderAttachmentsForDownload keeps mixed templates on the numbered-page rule', () => {
  const names = ['封面.png', '幻灯片2.png', '幻灯片1.png'];
  const ordered = orderAttachmentsForDownload(names.map(name => ({ name }))).map(item => item.name);
  assert.deepEqual(ordered, names);
});

test('downloadAttachment 断流等网络错误会重试，飞书明确返回的错误不重试', async () => {
  const FeishuClient = require('../src/feishu.js');
  const client = new FeishuClient({});
  const aborted = Object.assign(new Error('stream has been aborted'), { isAxiosError: true });
  let calls = 0;
  client.downloadAttachmentOnce = async () => {
    calls += 1;
    if (calls === 1) throw aborted;
    return '/tmp/ok.tmp';
  };
  assert.equal(await client.downloadAttachment('tok', '/tmp'), '/tmp/ok.tmp');
  assert.equal(calls, 2);

  const httpErr = Object.assign(new Error('HTTP 403'), { isAxiosError: true, response: { status: 403 } });
  calls = 0;
  client.downloadAttachmentOnce = async () => { calls += 1; throw httpErr; };
  await assert.rejects(client.downloadAttachment('tok', '/tmp'), /HTTP 403/);
  assert.equal(calls, 1);
});
