const test = require('node:test');
const assert = require('node:assert/strict');

const { validateGenerated } = require('../src/ai-writer.js');

function baseContent(overrides = {}) {
  return {
    title: '📌四下《母鸡》讲义，一页讲透省时间',
    description:
      '📌统编版四年级下册《母鸡》第一课时\n' +
      '📝导入环节用作者情感变化切入，梳理了重点词\n' +
      '✅问题设计有梯度，整体流程按情境推进\n' +
      '💡课堂直接可用，备课能省不少时间',
    tags: ['#母鸡', '#四年级语文', '#第一课时', '#小学语文', '#教学设计'],
    ...overrides,
  };
}

test('validateGenerated passes a well-formed xiaohongshu record', () => {
  const violations = validateGenerated(baseContent(), 'xiaohongshu');
  assert.deepEqual(violations, []);
});

test('validateGenerated passes a well-formed douyin record within tag limit', () => {
  const content = baseContent({ tags: ['#母鸡', '#四年级语文', '#第一课时', '#小学语文', '#教学设计'] });
  const violations = validateGenerated(content, 'douyin');
  assert.deepEqual(violations, []);
});

test('validateGenerated rejects title shorter than 10 chars', () => {
  const content = baseContent({ title: '📌太短了' });
  const violations = validateGenerated(content, 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('标题字数')), violations.join('; '));
});

test('validateGenerated rejects title longer than 20 chars', () => {
  const content = baseContent({
    title: '📌这是一个字数明显超过二十个字的超长标题不应该通过校验',
  });
  const violations = validateGenerated(content, 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('标题字数')), violations.join('; '));
});

test('validateGenerated rejects title with zero emoji', () => {
  const content = baseContent({ title: '四下《母鸡》讲义，一页讲透省时间啊' });
  const violations = validateGenerated(content, 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('emoji数量')), violations.join('; '));
});

test('validateGenerated rejects title with more than one emoji', () => {
  const content = baseContent({ title: '📌四下《母鸡》讲义，一页讲透📝' });
  const violations = validateGenerated(content, 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('emoji数量')), violations.join('; '));
});

test('validateGenerated rejects title with non-whitelisted emoji', () => {
  const content = baseContent({ title: '😀四下《母鸡》讲义，一页讲透省时间' });
  const violations = validateGenerated(content, 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('emoji')), violations.join('; '));
});

test('validateGenerated rejects title with more than one punctuation mark', () => {
  const content = baseContent({ title: '📌四下，母鸡讲义，一页讲透，省时间' });
  const violations = validateGenerated(content, 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('标点')), violations.join('; '));
});

test('validateGenerated rejects title containing a banned word', () => {
  const content = baseContent({ title: '📌四下母鸡讲义课堂可用讲透省时间' });
  const violations = validateGenerated(content, 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('禁用词')), violations.join('; '));
});

test('validateGenerated rejects empty description', () => {
  const content = baseContent({ description: '' });
  const violations = validateGenerated(content, 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('正文为空')), violations.join('; '));
});

test('validateGenerated rejects description outside 50-150 char range (too short)', () => {
  const content = baseContent({ description: '📌太短了\n📝不够字数' });
  const violations = validateGenerated(content, 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('正文字数')), violations.join('; '));
});

test('validateGenerated rejects description with fewer than 3 lines', () => {
  const content = baseContent({
    description: '📌统编版四年级下册《母鸡》第一课时，讲了作者情感变化的重点内容\n📝整体流程按情境推进，问题设计有梯度，课堂可直接使用',
  });
  const violations = validateGenerated(content, 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('分行数')), violations.join('; '));
});

test('validateGenerated rejects description line not starting with whitelisted emoji', () => {
  const content = baseContent({
    description:
      '📌统编版四年级下册《母鸡》第一课时\n' +
      '导入环节用作者情感变化切入，梳理了重点词\n' +
      '✅问题设计有梯度，整体流程按情境推进\n' +
      '💡课堂直接可用，备课能省不少时间',
  });
  const violations = validateGenerated(content, 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('行首不是白名单emoji')), violations.join('; '));
});

test('validateGenerated rejects tags exceeding xiaohongshu limit of 10', () => {
  const tags = Array.from({ length: 11 }, (_, i) => `#标签${i}`);
  const violations = validateGenerated(baseContent({ tags }), 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('标签数量')), violations.join('; '));
});

test('validateGenerated rejects tags exceeding douyin limit of 5', () => {
  const tags = Array.from({ length: 6 }, (_, i) => `#标签${i}`);
  const violations = validateGenerated(baseContent({ tags }), 'douyin');
  assert.ok(violations.some(v => v.includes('标签数量')), violations.join('; '));
});

test('validateGenerated rejects empty tags array', () => {
  const violations = validateGenerated(baseContent({ tags: [] }), 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('标签为空')), violations.join('; '));
});

test('validateGenerated rejects tags not starting with #', () => {
  const content = baseContent({ tags: ['母鸡', '#四年级语文'] });
  const violations = validateGenerated(content, 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('未以 # 开头')), violations.join('; '));
});

// ── 场景词越权（topic 参数） ──

test('validateGenerated rejects scene word in title search layer when topic lacks it', () => {
  const content = baseContent({
    title: '📌四下语文暑假预习清单，一页讲透省时间',
  });
  const violations = validateGenerated(content, 'xiaohongshu', '走进美丽乡村1-西游Q版闯关');
  assert.ok(violations.some(v => v.includes('场景词') && v.includes('暑假')), violations.join('; '));
});

test('validateGenerated rejects scene word in description when topic lacks it', () => {
  const content = baseContent({
    description:
      '📌统编版四年级下册《母鸡》第一课时\n' +
      '📝暑假预习内容，梳理了重点词\n' +
      '✅问题设计有梯度，整体流程按情境推进\n' +
      '💡课堂直接可用，备课能省不少时间',
  });
  const violations = validateGenerated(content, 'xiaohongshu', '走进美丽乡村1-西游Q版闯关');
  assert.ok(violations.some(v => v.includes('场景词') && v.includes('暑假')), violations.join('; '));
});

test('validateGenerated allows scene word when topic explicitly contains it', () => {
  const content = baseContent({
    title: '📌四下语文暑假预习清单，一页讲透省时间',
  });
  const violations = validateGenerated(content, 'xiaohongshu', '四年级语文暑假预习');
  assert.ok(!violations.some(v => v.includes('场景词')), violations.join('; '));
});

test('validateGenerated skips scene word check when topic is not passed', () => {
  const content = baseContent({
    title: '📌四下语文暑假预习清单，一页讲透省时间',
  });
  const violations = validateGenerated(content, 'xiaohongshu');
  assert.ok(!violations.some(v => v.includes('场景词')), violations.join('; '));
});

test('validateGenerated exempts "衔接" hook phrase in hook layer from scene word check', () => {
  const content = baseContent({
    title: '📌七升八英语讲义，衔接课备课不愁',
  });
  const violations = validateGenerated(content, 'xiaohongshu', '走进美丽乡村1-西游Q版闯关');
  assert.ok(!violations.some(v => v.includes('场景词')), violations.join('; '));
});

test('validateGenerated allows teaching-action usage like "复习导入" in description', () => {
  const content = baseContent({
    description:
      '📌统编版四年级下册《母鸡》第一课时\n' +
      '📝复习导入环节用作者情感变化切入，梳理了重点词\n' +
      '✅问题设计有梯度，整体流程按情境推进\n' +
      '💡课堂直接可用，备课能省不少时间',
  });
  const violations = validateGenerated(content, 'xiaohongshu', '走进美丽乡村1-西游Q版闯关');
  assert.ok(!violations.some(v => v.includes('场景词')), violations.join('; '));
});

test('validateGenerated rejects qualifier phrase "预习笔记" in description when topic lacks 预习', () => {
  const content = baseContent({
    description:
      '📌统编版四年级下册《母鸡》预习笔记\n' +
      '📝导入环节用作者情感变化切入，梳理了重点词\n' +
      '✅问题设计有梯度，整体流程按情境推进\n' +
      '💡课堂直接可用，备课能省不少时间',
  });
  const violations = validateGenerated(content, 'xiaohongshu', '走进美丽乡村1-西游Q版闯关');
  assert.ok(violations.some(v => v.includes('场景词') && v.includes('预习')), violations.join('; '));
});
