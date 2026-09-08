const test = require('node:test');
const assert = require('node:assert/strict');

const { validateGenerated } = require('../src/ai-writer.js');

// 校验器只管可机械确认的边界：标题字数、正文长度与最小排版、
// 标签数量/格式、营销话术禁词。内容真实性仍由 SYSTEM_PROMPT 与人工预览把关。

function baseContent(overrides = {}) {
  return {
    title: '北师大四上数学《乘法》课件笔记',
    description:
      '🧭北师大版四年级上册数学第三单元乘法课件\n' +
      '卫星运行时间、有多少名观众、神奇的计算工具\n\n' +
      '📚三个内容点顺着乘法计算往下走\n' +
      '先讲算理，再看计算工具怎么用',
    tags: ['#北师大数学', '#四上数学', '#数学课件', '#乘法', '#小学数学'],
    ...overrides,
  };
}

test('validateGenerated passes a well-formed xiaohongshu record', () => {
  const violations = validateGenerated(baseContent(), 'xiaohongshu');
  assert.deepEqual(violations, []);
});

test('validateGenerated passes a well-formed douyin record within tag limit', () => {
  const violations = validateGenerated(baseContent(), 'douyin');
  assert.deepEqual(violations, []);
});

test('validateGenerated passes a title without emoji', () => {
  const violations = validateGenerated(baseContent({ title: '人教六上数学第一单元备课笔记' }), 'xiaohongshu');
  assert.deepEqual(violations, []);
});

test('validateGenerated passes a title with one emoji', () => {
  const violations = validateGenerated(baseContent({ title: '📌北师大四上数学《乘法》课件' }), 'xiaohongshu');
  assert.deepEqual(violations, []);
});

test('validateGenerated counts 《》 into title length (exactly 20 chars passes)', () => {
  // 18 个汉字 + 《》2 字符 = 20，应恰好通过
  const violations = validateGenerated(baseContent({ title: '北师大版四年级上册数学《乘法》课件笔记' }), 'xiaohongshu');
  assert.deepEqual(violations, []);
});

test('validateGenerated rejects title shorter than 8 chars', () => {
  const violations = validateGenerated(baseContent({ title: '数学课件笔记' }), 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('标题字数')), violations.join('; '));
});

test('validateGenerated rejects title longer than 20 chars', () => {
  const violations = validateGenerated(
    baseContent({ title: '这是一个字数明显超过二十个字的超长标题不应该通过校验' }),
    'xiaohongshu'
  );
  assert.ok(violations.some(v => v.includes('标题字数')), violations.join('; '));
});

test('validateGenerated rejects empty title', () => {
  const violations = validateGenerated(baseContent({ title: '' }), 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('标题为空')), violations.join('; '));
});

test('validateGenerated rejects banned marketing word in title', () => {
  const violations = validateGenerated(baseContent({ title: '四上数学课件，建议收藏备用' }), 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('禁用词')), violations.join('; '));
});

test('validateGenerated rejects banned platform word in description', () => {
  const content = baseContent({
    description: '北师大四上数学课件\n需要的加我微信领取',
  });
  const violations = validateGenerated(content, 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('正文含禁用词')), violations.join('; '));
});

test('validateGenerated rejects empty description', () => {
  const violations = validateGenerated(baseContent({ description: '' }), 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('正文为空')), violations.join('; '));
});

test('validateGenerated rejects empty tags array', () => {
  const violations = validateGenerated(baseContent({ tags: [] }), 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('标签为空')), violations.join('; '));
});

test('validateGenerated rejects description without a blank line between content blocks', () => {
  const content = baseContent({
    description: '🧭北师大版四年级上册数学第三单元乘法课件\n卫星运行时间和神奇的计算工具\n📚先讲算理，再看计算工具怎么用',
  });
  const violations = validateGenerated(content, 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('空白行')), violations.join('; '));
});

test('validateGenerated rejects description without a paragraph-leading emoji', () => {
  const content = baseContent({
    description: '北师大版四年级上册数学第三单元乘法课件\n卫星运行时间和神奇的计算工具\n\n先讲算理，再看计算工具怎么用',
  });
  const violations = validateGenerated(content, 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('段首 emoji')), violations.join('; '));
});

test('validateGenerated rejects hashtags duplicated into description', () => {
  const content = baseContent({
    description: baseContent().description + '\n\n#四上数学 #教师备课',
  });
  const violations = validateGenerated(content, 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('标签必须保留在 tags 字段')), violations.join('; '));
});

test('validateGenerated rejects fewer than five tags', () => {
  const violations = validateGenerated(baseContent({ tags: ['#北师大数学', '#四上数学'] }), 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('少于下限 5')), violations.join('; '));
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

test('validateGenerated rejects tags not starting with #', () => {
  const content = baseContent({ tags: ['四上数学', '#北师大数学'] });
  const violations = validateGenerated(content, 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('未以 # 开头')), violations.join('; '));
});

// 红线⑤：完整性/引导翻图话术（2026-08-04 从旧「正文硬边界」段移入红线并补机械校验）
test('validateGenerated rejects false-completeness phrase in description (红线⑤)', () => {
  const content = baseContent({
    description: baseContent().description + '\n完整内容见图',
  });
  const violations = validateGenerated(content, 'xiaohongshu');
  assert.ok(violations.some(v => v.includes('虚假完整性话术')), violations.join('; '));
});

test('validateGenerated passes normal description without false-completeness phrase (红线⑤)', () => {
  const violations = validateGenerated(baseContent(), 'xiaohongshu');
  assert.deepEqual(violations, []);
});
