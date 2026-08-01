const test = require('node:test');
const assert = require('node:assert/strict');

const {
  escapeHtmlAttr,
  buildRichTopicDescription,
} = require('../src/publisher.js');

// 真实话题结构（取自生产日志 publisher-debug.log 中提交过的 raw 属性）
function xhsTopic(name, id) {
  return {
    yixiaoerId: id,
    yixiaoerName: name,
    raw: {
      smart: false,
      id,
      name,
      link: `https://www.xiaohongshu.com/page/topics/${id}?naviHidden=yes`,
      view_num: 27897694,
      type: 'official',
    },
  };
}

function douyinTopic(name, cid) {
  return {
    yixiaoerId: cid,
    yixiaoerName: name,
    raw: { cha_name: name, view_count: 35844584, cid, group_id: '6614564769246483715', tag: 0 },
  };
}

// ---------- escapeHtmlAttr ----------

test('escapeHtmlAttr 仍然转义单引号（单引号包裹属性时这条是必须的）', () => {
  assert.equal(escapeHtmlAttr("it's"), 'it&#39;s');
});

test('escapeHtmlAttr 仍然转义 & 和 <', () => {
  assert.equal(escapeHtmlAttr('a&b'), 'a&amp;b');
  assert.equal(escapeHtmlAttr('a<b'), 'a&lt;b');
});

test('escapeHtmlAttr 不再转义双引号（单引号包裹的属性值里双引号合法）', () => {
  assert.equal(escapeHtmlAttr('{"a":1}'), '{"a":1}');
  assert.ok(!escapeHtmlAttr('{"a":1}').includes('&quot;'));
});

test('escapeHtmlAttr 不会二次转义：& 先替换，实体只被转一次', () => {
  // 输入本身含实体写法时，只应把 & 转成 &amp;，不应再对 quot; 部分做任何处理
  assert.equal(escapeHtmlAttr('&quot;'), '&amp;quot;');
  assert.equal(escapeHtmlAttr('&amp;'), '&amp;amp;');
  // 反向验证：解码一次即可还原原文，说明没有多层转义
  const decodeOnce = s => s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&#96;/g, '`')
    .replace(/&amp;/g, '&');
  for (const raw of ['&quot;', '&amp;', `a&b<c'd"e`]) {
    assert.equal(decodeOnce(escapeHtmlAttr(raw)), raw);
  }
});

// ---------- buildRichTopicDescription 结构 ----------

test('buildRichTopicDescription 正文每行包一层 <p>，话题单独一段', () => {
  const html = buildRichTopicDescription(
    '第一行\n第二行',
    ['数学课件'],
    [douyinTopic('数学课件', '1626772471814151')]
  );
  assert.ok(html.startsWith('<p>第一行</p><p>第二行</p><p><topic '));
  assert.ok(html.endsWith('</topic></p>'));
  assert.match(html, /<topic text='数学课件' raw='\{.*\}'>#数学课件<\/topic>/);
});

test('buildRichTopicDescription 空描述空话题返回占位段落', () => {
  assert.equal(buildRichTopicDescription('', [], []), '<p></p>');
});

test('buildRichTopicDescription 未匹配到话题时只保留 text 属性，不产出 raw', () => {
  const html = buildRichTopicDescription('正文', ['无此话题'], []);
  assert.match(html, /<topic text='无此话题'>#无此话题<\/topic>/);
  assert.ok(!html.includes('raw='));
});

// ---------- 回归：改动后 HTML 仍可被正确解析回原值 ----------

test('回归：去掉双引号转义后，topic 的 text 和 raw 仍能被解析回原值（话题绑定未破坏）', () => {
  const topics = [
    xhsTopic('五上数学', '6116771900000000010058b6'),
    douyinTopic('数学课件', '1626772471814151'),
  ];
  const tags = topics.map(t => t.yixiaoerName);
  const html = buildRichTopicDescription('正文一行', tags, topics);

  // 用「单引号包裹属性」的规则解析：属性值一直读到下一个单引号
  const matches = [...html.matchAll(/<topic text='([^']*)'(?: raw='([^']*)')?>/g)];
  assert.equal(matches.length, topics.length);

  const decodeAttr = s => s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&#96;/g, '`')
    .replace(/&amp;/g, '&');

  matches.forEach((m, i) => {
    assert.equal(decodeAttr(m[1]), tags[i]);
    const parsed = JSON.parse(decodeAttr(m[2]));
    assert.equal(parsed.yixiaoerId, topics[i].yixiaoerId);
    assert.equal(parsed.yixiaoerName, topics[i].yixiaoerName);
    assert.deepEqual(parsed.raw, topics[i].raw);
  });
});

test('回归：话题名含单引号时属性不会被提前截断', () => {
  const topic = douyinTopic("it's math", '1626772471814151');
  const html = buildRichTopicDescription('正文', ["it's math"], [topic]);
  const m = html.match(/<topic text='([^']*)' raw='([^']*)'>/);
  assert.ok(m, '属性应能被单引号规则完整匹配');
  const decodeAttr = s => s.replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  assert.equal(decodeAttr(m[1]), "it's math");
  assert.equal(JSON.parse(decodeAttr(m[2])).raw.cha_name, "it's math");
});

// ---------- 不做本地长度拦截（决策回归） ----------

// 生产日志实证：71 次蚁小二接单成功的提交里有 65 次富文本长度就大于 1000（最长 1666），
// 说明 API 路径上不存在 1000 字闸门。曾加过本地预检，会把这些正常发布全打成「发布失败」，
// 已撤除。本用例固化该决策：真实的 5 话题场景长度确实超过 1000，但必须照常构造、不得拦截。
// 要重新引入长度校验，先拿到 API 侧真实拒绝样本，别再照搬网页编辑器的报错数字。
test('5 话题的真实场景长度超过 1000，但仍照常构造富文本、不做本地拦截', () => {
  const tags = ['五上数学', '数学课件', '教学设计', '北师大数学', '西游闯关版'];
  const topics = [
    xhsTopic('五上数学', '6116771900000000010058b6'),
    xhsTopic('数学课件', '60ba2e7f0000000001000164'),
    xhsTopic('教学设计', '5c787214000000000f02356d'),
    xhsTopic('北师大数学', '5dff77e6000000000100301c'),
    xhsTopic('西游闯关版', '6a54e88c000000000301ed2e'),
  ];

  let html;
  assert.doesNotThrow(() => {
    html = buildRichTopicDescription('北师大版五年级上册数学第一单元第7课时', tags, topics);
  });
  assert.ok(html.length > 1000, '真实 5 话题场景长度本就超过 1000，这正是不能拦的原因');
  assert.equal((html.match(/<topic /g) || []).length, 5, '五个话题都要保留，不得被截断或删减');
});
