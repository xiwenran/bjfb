const test = require('node:test');
const assert = require('node:assert/strict');

const {
  escapeHtmlAttr,
  buildRichTopicDescription,
} = require('../src/publisher.js');

// 目标格式（蚁小二官方开源仓库 yixiaoer-skill 规范）：
//   <p>正文</p><p><topic text="合拍">#合拍</topic><topic text="夏日">#夏日</topic></p>
// 依据：internal/modules/publish/preflight.go 的 buildTopicHTML
//   fmt.Sprintf(`<topic text="%s">%s</topic>`, text, tag)
// 以及 skills/yixiaoer/references/topic-tags.md：「text 属性应为不带 # 的标签文本」。
// 只有 text 一个属性、双引号包裹、没有 raw。

// 用「双引号包裹属性」的规则解析出所有 topic
function parseTopics(html) {
  return [...html.matchAll(/<topic text="([^"]*)">([^<]*)<\/topic>/g)];
}

function decodeAttr(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------- escapeHtmlAttr ----------

test('escapeHtmlAttr 转义双引号（双引号包裹属性时这条是必须的）', () => {
  assert.equal(escapeHtmlAttr('说"你好"'), '说&quot;你好&quot;');
});

test('escapeHtmlAttr 仍然转义 &、<、>、单引号', () => {
  assert.equal(escapeHtmlAttr('a&b'), 'a&amp;b');
  assert.equal(escapeHtmlAttr('a<b'), 'a&lt;b');
  assert.equal(escapeHtmlAttr('a>b'), 'a&gt;b');
  assert.equal(escapeHtmlAttr("it's"), 'it&#39;s');
});

test('escapeHtmlAttr 不会二次转义：& 先替换，实体只被转一次', () => {
  assert.equal(escapeHtmlAttr('&quot;'), '&amp;quot;');
  assert.equal(escapeHtmlAttr('&amp;'), '&amp;amp;');
  for (const raw of ['&quot;', '&amp;', `a&b<c'd"e>f`]) {
    assert.equal(decodeAttr(escapeHtmlAttr(raw)), raw);
  }
});

// ---------- buildRichTopicDescription 结构 ----------

test('buildRichTopicDescription 产出官方格式：双引号包裹、只有 text 属性、无 raw', () => {
  const html = buildRichTopicDescription('第一行\n第二行', ['合拍', '夏日']);
  assert.equal(
    html,
    '<p>第一行</p><p>第二行</p>'
    + '<p><topic text="合拍">#合拍</topic><topic text="夏日">#夏日</topic></p>'
  );
  assert.ok(!html.includes('raw='), '官方格式没有 raw 属性');
  assert.ok(!html.includes("text='"), '属性必须用双引号包裹');
});

test('buildRichTopicDescription 空描述空话题返回占位段落', () => {
  assert.equal(buildRichTopicDescription('', []), '<p></p>');
});

test('buildRichTopicDescription 只有话题没有正文时，只产出话题段落', () => {
  assert.equal(
    buildRichTopicDescription('', ['数学课件']),
    '<p><topic text="数学课件">#数学课件</topic></p>'
  );
});

test('buildRichTopicDescription 第三个参数已废弃：多传话题对象也不影响输出', () => {
  const withExtra = buildRichTopicDescription('正文', ['数学课件'], [
    { yixiaoerId: '1626772471814151', yixiaoerName: '数学课件', raw: { cha_name: '数学课件' } },
  ]);
  assert.equal(withExtra, buildRichTopicDescription('正文', ['数学课件']));
  assert.ok(!withExtra.includes('raw='));
  assert.ok(!withExtra.includes('1626772471814151'));
});

// ---------- 属性无损还原 / 无法提前闭合 ----------

test('text 属性在含单引号、双引号、<、>、&、emoji 时都能无损还原', () => {
  const tags = [
    "it's math",
    '说"你好"',
    'a<b',
    'a>b',
    'AT&T',
    '数学🎉课件',
    `混合 & < > " ' 🎯`,
  ];
  const html = buildRichTopicDescription('正文', tags);
  const matches = parseTopics(html);
  assert.equal(matches.length, tags.length, '每个标签都应能被双引号规则完整匹配');
  matches.forEach((m, i) => {
    assert.equal(decodeAttr(m[1]), tags[i], 'text 属性应无损还原');
    assert.equal(decodeAttr(m[2]), `#${tags[i]}`, '标签正文应为 #标签名');
  });
});

test('构造不出让属性提前闭合的输入：注入尝试全部被转义', () => {
  const attacks = [
    '"><script>alert(1)</script>',
    '" onclick="x',
    '"></topic><topic text="伪造',
    "'></topic>",
  ];
  const html = buildRichTopicDescription('正文', attacks);
  const matches = parseTopics(html);
  assert.equal(matches.length, attacks.length, '注入不应制造出额外或缺失的 topic 节点');
  matches.forEach((m, i) => {
    assert.equal(decodeAttr(m[1]), attacks[i]);
  });
  assert.ok(!html.includes('<script'), '尖括号必须已被转义');
  // `onclick="` 出现在文本节点里是无害的（文本节点中引号合法），危险的只有它出现在
  // 起始标签内部——那意味着逃出了属性值、变成了真正的新属性。下面按起始标签逐个查。
  const startTags = html.match(/<topic[^>]*>/g) || [];
  assert.equal(startTags.length, attacks.length);
  startTags.forEach(tag => {
    // 起始标签内除了 text=" 与其收尾的引号，不应再有第三个未转义的双引号；
    // 两个引号 ⇒ 属性没有被提前闭合，`onclick=` 之类只能作为转义后的文本留在值里
    assert.equal((tag.match(/"/g) || []).length, 2, `属性引号必须成对且不被撑破: ${tag}`);
    assert.match(tag, /^<topic text="[^"]*">$/, `起始标签只允许 text 一个属性: ${tag}`);
  });
  // topic 起始标签数量应与标签数一致，没有被伪造出多余节点
  assert.equal((html.match(/<topic /g) || []).length, attacks.length);
});

// ---------- 长度：回归官方格式后大幅下降 ----------

// 背景：知发此前自创 raw 属性，塞整个话题对象 JSON，把 description 撑到
// schema 上限（1000）的两倍（生产日志 54 个样本中位 1885、最大 2358，全部超限），
// 抖音客户端因此报「不可超过1000个字，当前1069」而可见文字只有约 110 字。
// 回归官方格式后同样场景应远小于 1000。
// 注意：这里验证的是「长度自然下降」，不是新增本地长度闸门——
// API 侧不存在 1000 字闸门（生产日志实证），代码里也不做长度拦截。
test('真实 5 话题场景回归官方格式后长度远小于 1000', () => {
  const description = [
    '北师大版五年级上册数学第一单元第7课时《歌手大赛》（西游闯关版）',
    '配套资料有授课课件、逐字稿，逐字稿照读即可用于上课。',
    '还整理了教学设计和学习单，备课资料一次配齐。',
  ].join('\n');
  const tags = ['五上数学', '数学课件', '教学设计', '北师大数学', '西游闯关版'];

  const html = buildRichTopicDescription(description, tags);
  assert.equal((html.match(/<topic /g) || []).length, 5, '五个话题都要保留');
  assert.ok(html.length < 1000, `官方格式下应远小于 1000，实际 ${html.length}`);
  // 结构开销固定：每个话题 ≈ 30 字符 + 标签文本两遍
  const visible = description.replace(/\n/g, '').length
    + tags.reduce((s, t) => s + t.length + 1, 0);
  assert.ok(html.length < visible * 4, '结构开销应保持在可见文字的几倍以内');
});
