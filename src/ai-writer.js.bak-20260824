const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// System Prompt（2026-07-10 重构：原则驱动 + 搜索流量优先，替代旧「双层结构+钩子菜单+公式」体系）
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `你是一线教师账号的内容助手，帮教师把教学资料发布到小红书/抖音。

**任务**
根据笔记主题和图片文件名，一次性生成标题（title）、正文（description）、标签（tags）三项内容，均不得为空。

---

**核心目标（一切取舍以此为准）**

这类账号的流量来自平台搜索，不来自推荐流。
1. 先判断这份资料是什么：课件、教学设计、知识点总结、复习清单、家长会、班会……不预设分类清单，按主题和文件名语义判断。
2. 再想「需要这份资料的老师会搜什么词」：教材版本、年级册别、学科、单元/课名、资料形态等。
3. 标题和正文的唯一任务：让搜这些词的老师能搜到这篇笔记，并一眼看懂这是什么资料。

---

**三条原则（靠你的语义判断执行，没有词表和公式）**

1. **真实**：所有信息只能来自笔记主题和图片文件名。主题里没有的属性一律不写——课时划分、板书、可打印、教案、习题、答案、全册/全套、已更新、使用场景（预习/复习/假期/开学等）、教学效果、外部认可，这些只是常见的编造例子，不是穷举；一个说法算不算编造，按「主题和文件名里找得到出处吗」判断，宁可不写，不许臆造。
2. **搜索优先，自然表达**：标题以搜索关键词为主体（主题里真实存在的版本/年级/学科/课名/形态要素），组织成一句自然流畅的话，像老师随手发的笔记名，不堆砌、不营销、不写情绪钩子。课文名保留书名号。标题最多带 1 个 emoji（可以不带），要带就从白名单里选：📌 🔥 ✅ 💡 ✨ 📝。
3. **每篇不同**：同批次生成多篇时，各篇围绕自己的课名/单元/内容点来写，不套用同一句式模板；任意两篇标题除课名/单元外不得雷同。

---

**正文写法（2026-08-04 用户逐轮敲定，字面照抄，不改写不压缩）**

**写给谁看**

买家是一线老师，正在决定这份资料值不值得下手。他要知道的是这份东西怎么帮他把课上下来——有哪些环节、关键地方怎么处理、配了什么件。课本上的知识他自己就懂，不需要科普。

**写什么**

开头一句说清这是什么、难在哪。中间按资料的实际结构走——三步设计就写三步，两道关就写两道关，全册教案就写规模和栏目。结尾有真东西就说一句，没有就停。

骨架按品类走，不套同一个模板：单课课件写这节课怎么上（环节设计加关键处理）；语法专题写解决什么混淆、判断路径怎么拆；全册教案写结构规模、栏目构成、版本差异。

结尾那句只能是两种来源：引用资料里的原话，或者对资料结构的观察。

数字要实数。页数、单元数、课时数、词表数量，都从实物数出来，不许估。具体到刺眼才不像模板——336页、40个抽象名词、9个单元50个课时。

**怎么写**

句子之间不搭桥，段落之间也不搭。上一段说完这件事，下一段直接说下一件，不要过渡句。前后关系读的人自己会接。

句子不用捋顺。语序颠倒、说了一半绕回来、前后半句不完全对齐，都留着。处处通顺、每句都站得住，恰恰是最重的 AI 痕迹。分寸是不影响读懂。

长短拉开。该展开的掰碎了说，次要的一句带过，有时候三个字就是一句。

允许絮叨。同一个意思换句话再说一遍，加一句「就这么简单」这样的补白，带上「其实」「还挺」「根本」「才」这类口头词。写得干净利落是 AI 的习惯，人说话会重复会啰嗦。

说点没关系的废话。一篇里放一两句跟资料没关系的话——一句随口的评论、一个冷知识。比如「艾青写这首诗那年才28岁」。这种话对买家决策毫无用处，但它是全篇最不像 AI 的地方。AI 每句都在干活，人不是。

用大白话的动词。用、改、有、就、能，而不是使用、进行优化、具备、从而、可以实现。专业表述保留原样——压低放重、作主语宾语、单元教材分析，老师就这么说。

有立场。哪块难、哪块最费劲、哪页最值、哪块学生容易卡，直接说。这是对资料和课的判断，写得出来说明真读过。

**标点**

句号能少则少，段落末尾不加句号。中间的停顿优先用逗号，一句话可以一路连很长，不用急着断。

按手打习惯来。并列项直接用空格或顿号隔开，要强调的词直接写不加引号，课文名在正文里也不加书名号。冒号、破折号、分号是排版习惯，手打时基本不出现。书名号只在标题里保留，那是搜索词的视觉锚点。

**排版**

段落要有分量，2 到 4 行为主，整篇 3 到 5 段。句子之间用逗号连着走，一段说完一件事再换行。

松散体现在句子层面，不是靠把每句拆成一行——那样看着碎，读起来累。

只有一种情况可以单独占一行：那句跟正事无关的废话。孤零零杵着才有味道。

正文里可以用 emoji，放在段首当视觉锚点，不放段尾，全篇 2 到 4 个。挑跟这一段内容对得上的符号，避开促销感强的（连串感叹、💰🔥 这类）。不是每段都要放，没合适的就不放。

正文 200 字以内。写到 100 多字把该说的说清楚就可以收，不必凑字数——结构性资料（全册教案这类）本来就没那么多可说的，硬凑出来的都是水话。

**标签写法**

- 全部用搜索词标签，从主题要素派生：版本+学科（#北师大数学）、年级册别+学科（#四上数学）、资料形态（#数学课件 #教学设计）、单元/课名（#分数除法）、学段人群（#小学数学 #教师备课）。
- 少而准，不凑数，不用情绪或夸张标签。

---

**硬边界（程序机械校验，违反即打回重写）**

1. 标题 10-20 字：所有字符全部计入，《》每个符号计 1 字、emoji 计 1 字，与程序逐字符计数完全一致。
2. 标题白名单 emoji 最多 1 个（📌 🔥 ✅ 💡 ✨ 📝），可以 0 个：2 个及以上会被打回，白名单外的 emoji 不算数。
3. 标题标点最多 1 个（书名号《》与 emoji 不计入标点）。
4. description 50-200 字。
5. 标签数量：小红书最多 10 个，抖音最多 5 个，每个以 # 开头。
6. 禁止营销话术与平台敏感词（标题和正文都适用）：
   引导互动类——关注我、私信我、评论区见、点赞收藏、点个赞、双击666、快码住、赶紧、别错过、一键三连、关注不迷路、直接用、直接套用、点击收藏、建议收藏、码住备用、赶紧收藏；
   平台敏感类——微信、wx、加我、v我、购买、下单、链接、二维码、免费领取、低价、白嫖、带货、佣金、分销、扫码。

---

**平台判断**
用户输入包含「发布平台：抖音」→ 标签不超过 5 个；其余情况（小红书/两者均有/未指定）→ 标签不超过 10 个。

---

**输出格式（严格遵守，违反即失败）**

1. 只输出一行 JSON，不要任何其他内容——不要思考过程、不要解释、不要代码块标记。
2. description 内换行用两个字符 \\n 表示，不要直接回车。
3. description 内如需引用文字用中文引号「」，不要用英文双引号（会破坏 JSON 结构）。
4. 字段固定：title → description → tags。

示例（仅示意格式和口吻，不要照抄句式）：
{"title":"北师大四上数学《乘法》课件笔记","description":"北师大版四年级上册数学第三单元《乘法》课件\\n覆盖：卫星运行时间、有多少名观众、神奇的计算工具","tags":["#北师大数学","#四上数学","#数学课件","#乘法","#小学数学","#教师备课"]}`;

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

function buildUserMessage(record) {
  const topic = record.topic || '';
  const contentGroup = record.contentGroup || record.accountGroup || '';
  const pptTopic = record.pptTopic || '';
  const noteTitle = record.noteTitle || '';
  const attachmentNames = Array.isArray(record.attachments)
    ? record.attachments.map(item => item?.name).filter(Boolean).slice(0, 12)
    : [];
  const xhsAccount = record.xiaohongshuAccount || '';
  const dyAccount = record.douyinAccount || '';

  let platformHint = '';
  if (xhsAccount && dyAccount) {
    platformHint = '发布平台：小红书和抖音均有，优先按小红书风格生成';
  } else if (xhsAccount) {
    platformHint = '发布平台：小红书';
  } else if (dyAccount) {
    platformHint = '发布平台：抖音';
  } else {
    platformHint = '发布平台：未指定，默认按小红书风格生成';
  }

  return [
    contentGroup ? `内容分组：${contentGroup}` : '',
    pptTopic ? `PPT主题目录：${pptTopic}` : '',
    noteTitle ? `笔记目录名：${noteTitle}` : '',
    `笔记主题：${topic}`,
    attachmentNames.length ? `图片文件名：${attachmentNames.join('、')}` : '',
    platformHint,
    '标题要求：以搜索关键词为主体、自然流畅，8-20字（全字符计数，含《》和emoji）。',
  ].filter(Boolean).join('\n');
}

// 读取本地图片为 base64
// maxCount 默认 3：每张典型照片 1-2MB，8 张=16MB base64，中转服务处理时间 60-120s
// 会触发 timeout 120000ms exceeded。3 张约 6MB，处理通常在 30s 以内。
// 可通过 config.aiWriting.maxImages 调整（用户需要更多图片上下文时）。
const DEFAULT_IMAGE_MAX_COUNT = 3;
function loadImages(imagePaths, maxCount) {
  if (!imagePaths || imagePaths.length === 0) return [];
  const limit = (maxCount && maxCount > 0) ? maxCount : DEFAULT_IMAGE_MAX_COUNT;
  return imagePaths
    .slice(0, limit)
    .filter(p => p && fs.existsSync(p))
    .map(p => {
      const ext = path.extname(p).toLowerCase();
      const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.gif' ? 'image/gif'
        : ext === '.webp' ? 'image/webp'
        : 'image/png';
      return { mimeType, data: fs.readFileSync(p).toString('base64') };
    });
}

// JSON 字符串值内的原始控制字符（换行、回车、制表符）在 JSON 规范里是非法的。
// 部分模型输出多行 JSON 时会在 description 等字段里用真实换行而非 \n 转义序列。
// 这里做一次状态机扫描：只在字符串内部把原始控制字符替换成合法的转义序列。
function fixControlCharsInJsonStrings(str) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) { result += ch; escaped = false; continue; }
    if (ch === '\\') { escaped = true; result += ch; continue; }
    if (ch === '"') { inString = !inString; result += ch; continue; }
    if (inString) {
      if (ch === '\n') { result += '\\n'; continue; }
      if (ch === '\r') { result += '\\r'; continue; }
      if (ch === '\t') { result += '\\t'; continue; }
    }
    result += ch;
  }
  return result;
}

// 从混杂文本里抽出第一个完整的 JSON 对象。
// 用括号栈匹配，跳过字符串内的 {/}，处理转义字符。
function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// 最后手段：不依赖 JSON.parse，直接用字段边界正则提取 title/description/tags。
// 专门应对模型在 description 文本里用了未转义双引号（如 "健康快乐就好"）导致 JSON 损坏的情况。
// 贪婪 [\s\S]* 会吞掉所有字符（含裸引号），再向左回溯到已知边界 ","fieldname":。
function extractFieldsLenient(text) {
  // 用贪婪匹配兜住 description 里的裸双引号，但限制"不能跨越 ","tags": 两次"——
  // 正则引擎贪婪回溯会自动找到紧靠 ","tags": 的最右位置，实践中已够用。
  const titleMatch  = text.match(/"title"\s*:\s*"([\s\S]*)"\s*,\s*"description"\s*:/);
  const descMatch   = text.match(/"description"\s*:\s*"([\s\S]*)"\s*,\s*"tags"\s*:\s*\[/);
  const tagsBlock   = text.match(/"tags"\s*:\s*(\[[\s\S]*?\])/);
  if (!titleMatch || !descMatch || !tagsBlock) return null;

  // 处理模型输出的合法 JSON 转义序列（\n \t \\ \"）
  // 必须先保护 \\ 再处理 \n 等，否则 \\n → 先被 \n 规则误转为换行
  const unescape = s => s
    .replace(/\\\\/g, '\x00')   // \\ → 占位符
    .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\x00/g, '\\');    // 占位符 → \

  const title       = unescape(titleMatch[1]);
  const description = unescape(descMatch[1]);

  // tags 里全是 #hashtag，没有裸引号，标准正则即可
  const tags = [];
  const tagRe = /"([^"]+)"/g;
  let m;
  while ((m = tagRe.exec(tagsBlock[1])) !== null) tags.push(m[1]);

  // 结构性提取只检查 title 和 tags 是否存在；description 的内容规则（非空/字数/分行）
  // 由 validateGenerated 在 generateContent 里统一校验，这里不重复判断
  if (!title || tags.length === 0) return null;
  return { title, description, tags };
}

function validateAiResult(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('AI 返回不是 JSON 对象');
  }
  // 结构性检查：只要求 title 和 tags 存在；description 的内容规则由 validateGenerated 校验
  if (!result.title || !Array.isArray(result.tags) || result.tags.length === 0) {
    throw new Error('AI 返回格式不完整，缺少 title/tags 或 tags 为空数组');
  }
  return result;
}

function parseAiResponse(text) {
  let cleaned = String(text || '').trim();
  // 0. 去掉 <think>...</think> 推理段（部分推理模型会在 JSON 前输出思考过程）
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // 1. 去掉 markdown 代码块包裹（```json ... ``` 或 ``` ... ```）
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  // 2. 修复 JSON 字符串值内的原始控制字符（换行/回车/制表符），再尝试直接解析
  const fixed = fixControlCharsInJsonStrings(cleaned);
  try {
    return validateAiResult(JSON.parse(fixed));
  } catch (e) {
    // 解析失败 → 进入容错路径
  }

  // 3. 从混杂文本中抽出第一个完整 {...}（应对 AI 带前置说明文字、markdown 等情况）
  const extracted = extractFirstJsonObject(fixed);
  if (extracted) {
    try {
      return validateAiResult(JSON.parse(extracted));
    } catch (e) {
      // 抽取的也解析失败 → 进入下一步
    }
  }

  // 4. 容错字段提取：专门应对 description 里有未转义双引号的情况，完全绕过 JSON.parse
  const lenient = extractFieldsLenient(fixed);
  if (lenient) {
    try {
      return validateAiResult(lenient);
    } catch (e) {
      // 字段提取后 validate 失败 → 进入兜底
    }
  }

  // 5. 兜底：抛错，前端走"跳过/手填"分支，并把模型实际返回的前 300 字给用户看
  const preview = cleaned.slice(0, 300).replace(/\s+/g, ' ');
  throw new Error('AI 未按要求输出 JSON。模型实际返回（截取）：' + preview);
}

// ─────────────────────────────────────────────
// 机械校验（2026-07-10 重构）：只校验硬边界——字数 / 标签数量 / 营销话术禁词。
// 内容真实性、搜索词质量、句式差异由 SYSTEM_PROMPT 原则约束 + dry-run 人工预览兜底，
// 不再维护钩子菜单 / 场景词表 / emoji 白名单 / 标点计数等规则型校验。
// ─────────────────────────────────────────────

// 营销话术 + 平台敏感词：标题和正文都禁用，与 SYSTEM_PROMPT「硬边界」第 3 条保持一致
const BANNED_WORDS = [
  // 引导互动类
  '关注我', '私信我', '评论区见', '点赞收藏', '点个赞', '双击666',
  '快码住', '赶紧', '别错过', '一键三连', '关注不迷路',
  '直接用', '直接套用', '点击收藏', '建议收藏', '码住备用', '赶紧收藏',
  // 平台敏感类
  '微信', 'wx', '加我', 'v我', '购买', '下单', '链接', '二维码',
  '免费领取', '低价', '白嫖', '带货', '佣金', '分销', '扫码',
];

// ─────────────────────────────────────────────
// 四条红线（2026-08-04 补，账号被判「内容相似度高、缺少真诚个人表达」后新增）
// 与上面 BANNED_WORDS 的区别：BANNED_WORDS 是平台/营销敏感词，这四条是账号被判定
// 相似度高之后新加的内容真实性/安全红线，各自独立判断、独立返回违规项。
// ─────────────────────────────────────────────

// 红线①使用经历词：只拦「我用过之后怎样」这一类，不拦对资料/学科本身的判断句
// （例：「这页我觉得最值」「这单元本来就绕」合法，不在此表内，不会被拦）
const EXPERIENCE_WORDS = ['我的体会', '自己做下来', '备课时发现', '亲测', '用下来', '我讲这课'];

// 红线②无法验证的承诺：读者读完正文无法证伪，但夸大到失真的说法
const PROMISE_WORDS = ['直接抄进', '照着讲就行', '新老师也能上', '拿来就能用'];

// 红线③联系方式：微信号/QQ号/手机号/二维码提示，命中任一即判违规
const CONTACT_INFO_PATTERNS = [
  { pattern: /微信\s*[:：]?\s*[a-zA-Z0-9_-]{4,20}/, label: '微信号' },
  { pattern: /\bqq\s*[:：]?\s*\d{5,11}\b/i, label: 'QQ号' },
  { pattern: /1[3-9]\d{9}/, label: '手机号' },
  { pattern: /(二维码|扫码|扫一扫)/, label: '二维码提示' },
];

// 红线④配套件回查：正文/标题提到这些配套件时，必须能在资产库里查到对应 artifact_key
// （key 取值对齐 ~/teacher/publish-library/.asset-db/assets.sqlite3 的 artifacts.artifact_key）
// 红线⑤完整性/引导翻图话术（原「正文硬边界」2026-07-11 条款，2026-08-04 随旧段删除时
// 单独移入红线并补上机械校验）：发布的图片只是这份资料的一部分，声称「完整内容都在图里」
// 是虚假宣传，不是文风问题，所以留在红线层而不是引导层。
const FALSE_COMPLETENESS_PHRASES = [
  '图片即为课件完整内容', '完整内容见图', '内容按图整理',
  '按教材页面顺序整理', '需要的老师可以翻图查看', '完整版在图里',
];

const PACKAGE_ITEM_KEYWORDS = {
  '教案': 'teacher_lesson_plan',
  '逐字稿': 'teacher_transcript',
  '学习单': 'teacher_worksheet',
  '板书': 'teacher_blackboard',
};

function countCodepoints(str) {
  return Array.from(String(str || '')).length;
}

function platformTagLimit(platform) {
  return platform === 'douyin' ? 5 : 10;
}

// 根据记录的账号字段判断平台，与 buildUserMessage 的 platformHint 逻辑保持一致
function determinePlatform(record) {
  const xhsAccount = record?.xiaohongshuAccount || '';
  const dyAccount = record?.douyinAccount || '';
  if (dyAccount && !xhsAccount) return 'douyin';
  return 'xiaohongshu';
}

// 校验 AI 生成内容的硬边界，返回违规项数组（空数组=通过）
// availableArtifacts：调用方传入的该产品已确认存在的配套件 artifact_key 数组（可选）。
// 见文件底部「配套件回查架构说明」——ai-writer.js 不直接连教师产品资产库的 sqlite，
// 由调用方查库后把清单传进来；不传时红线④对提到配套件的正文一律 fail-closed。
function validateGenerated(content, platform, availableArtifacts) {
  const violations = [];
  const title = String(content?.title || '');
  const description = String(content?.description || '');
  const tags = Array.isArray(content?.tags) ? content.tags : [];
  const combinedText = `${title}\n${description}`;

  // ── 标题 ──
  if (!title) {
    violations.push('标题为空');
  } else {
    const titleLen = countCodepoints(title);
    if (titleLen < 8 || titleLen > 20) {
      violations.push(`标题字数 ${titleLen} 不在 8-20 区间（全字符计数，含《》和emoji）`);
    }
    const titleBanned = BANNED_WORDS.find(word => title.includes(word));
    if (titleBanned) {
      violations.push(`标题含禁用词「${titleBanned}」`);
    }
  }

  // ── 正文 ──
  if (!description.trim()) {
    violations.push('正文为空，正文必须撰写');
  } else {
    const descLen = countCodepoints(description);
    if (descLen < 50 || descLen > 200) {
      violations.push(`正文字数 ${descLen} 不在 50-200 区间`);
    }
    const descBanned = BANNED_WORDS.find(word => description.includes(word));
    if (descBanned) {
      violations.push(`正文含禁用词「${descBanned}」`);
    }
  }

  // ── 标签 ──
  const limit = platformTagLimit(platform);
  if (tags.length === 0) {
    violations.push('标签为空');
  } else if (tags.length > limit) {
    violations.push(`标签数量 ${tags.length} 超过平台上限 ${limit}（${platform === 'douyin' ? '抖音' : '小红书'}）`);
  }
  const badTagIndex = tags.findIndex(tag => typeof tag !== 'string' || !tag.startsWith('#'));
  if (badTagIndex >= 0) {
    violations.push(`标签[${badTagIndex}]未以 # 开头`);
  }

  // ── 红线①使用经历词：只拦「我用过之后如何」，说资料/说学科本身的判断句放行 ──
  const experienceHit = EXPERIENCE_WORDS.find(word => description.includes(word));
  if (experienceHit) {
    violations.push(`正文含使用经历表述「${experienceHit}」（只能评价资料/学科本身，不能写自己用过之后的体会）`);
  }

  // ── 红线②无法验证的承诺 ──
  const promiseHit = PROMISE_WORDS.find(word => combinedText.includes(word));
  if (promiseHit) {
    violations.push(`含无法验证的承诺「${promiseHit}」`);
  }

  // ── 红线③联系方式/二维码：命中一类即够，不逐类重复判 ──
  const contactHit = CONTACT_INFO_PATTERNS.find(({ pattern }) => pattern.test(combinedText));
  if (contactHit) {
    violations.push(`正文或标题含联系方式（疑似${contactHit.label}），禁止出现`);
  }

  // ── 红线④配套件回查：提到教案/逐字稿/学习单/板书时，必须能在资产库查到对应 artifact ──
  const mentionedItems = Object.entries(PACKAGE_ITEM_KEYWORDS)
    .filter(([word]) => combinedText.includes(word));
  if (mentionedItems.length > 0) {
    if (!Array.isArray(availableArtifacts)) {
      // fail-closed：拿不到配套件清单时一律判定为无法校验并打回，不能默认放行
      const words = mentionedItems.map(([word]) => word).join('、');
      violations.push(`正文或标题提到「${words}」，但未提供配套件清单，无法校验，判定为不合格`);
    } else {
      const missing = mentionedItems.filter(([, key]) => !availableArtifacts.includes(key));
      if (missing.length > 0) {
        const words = missing.map(([word]) => word).join('、');
        violations.push(`正文或标题提到「${words}」，但该产品资产库里查不到对应配套件`);
      }
    }
  }

  // ── 红线⑤完整性/引导翻图话术：图片只是资料的一部分，暗示图=全部内容属虚假宣传 ──
  const falseCompletenessHit = FALSE_COMPLETENESS_PHRASES.find(phrase => combinedText.includes(phrase));
  if (falseCompletenessHit) {
    violations.push(`正文或标题含虚假完整性话术「${falseCompletenessHit}」（图片只是资料一部分，不能暗示图=全部内容）`);
  }

  return violations;
}

// ─────────────────────────────────────────────
// 重试 helper:仅对超时/网络抖动/网关错误重试 1 次,2 秒间隔
// 不针对认证错误(401/403)、参数错误(400/422)等业务错误重试,避免浪费 quota
// ─────────────────────────────────────────────
async function callAiWithRetry(callFn) {
  try {
    return await callFn();
  } catch (err) {
    const status = err.response?.status;
    const code = err.code;
    const isRetryable =
      code === 'ECONNABORTED' ||  // axios timeout (超时上限达到)
      code === 'ECONNRESET' ||     // 连接被重置
      code === 'ETIMEDOUT' ||      // 系统级网络超时
      status === 408 || status === 429 ||
      status === 502 || status === 503 || status === 504;
    if (!isRetryable) throw err;
    // 等 1 秒重试 1 次（去掉图片后请求体小，超时说明中转站问题，快速重试即可）
    await new Promise((r) => setTimeout(r, 1000));
    return await callFn();
  }
}

// ─────────────────────────────────────────────
// Provider 调用实现
// ─────────────────────────────────────────────

async function callOpenAI(aiConfig, userMessage, images) {
  const baseUrl = (aiConfig.apiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  // 有图片时构建多模态 content 数组
  const userContent = images && images.length > 0
    ? [
        { type: 'text', text: userMessage },
        ...images.map(img => ({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType};base64,${img.data}`, detail: 'low' },
        })),
      ]
    : userMessage;
  // 优先用 response_format: json_object 强制 JSON 输出（OpenAI 官方支持，
  // 大多数中转站也兼容）。如果模型/中转站不支持会返回 400，降级重试一次不带这个参数。
  const baseBody = {
    model: aiConfig.model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0.7,
    max_tokens: 1024,
  };
  const headers = {
    Authorization: `Bearer ${aiConfig.apiKey}`,
    'Content-Type': 'application/json',
  };
  try {
    const resp = await axios.post(
      `${baseUrl}/chat/completions`,
      { ...baseBody, response_format: { type: 'json_object' } },
      { headers, timeout: 45000 }
    );
    return resp.data.choices[0].message.content;
  } catch (err) {
    // 中转站/模型不支持 response_format 时降级重试（典型 400 错误信息含 "response_format" 关键字）
    const status = err.response?.status;
    const errMsg = String(err.response?.data?.error?.message || err.message || '');
    const isFormatNotSupported = (status === 400 || status === 422) &&
      /response_format|json_object|invalid.*parameter|unrecognized/i.test(errMsg);
    if (!isFormatNotSupported) throw err;
    const fallback = await axios.post(
      `${baseUrl}/chat/completions`,
      baseBody,
      { headers, timeout: 45000 }
    );
    return fallback.data.choices[0].message.content;
  }
}

async function callAnthropic(aiConfig, userMessage, images) {
  const userContent = images && images.length > 0
    ? [
        ...images.map(img => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType, data: img.data },
        })),
        { type: 'text', text: userMessage },
      ]
    : userMessage;
  const resp = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: aiConfig.model || 'claude-3-5-haiku-20241022',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    },
    {
      headers: {
        'x-api-key': aiConfig.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      timeout: 45000,
    }
  );
  return resp.data.content[0].text;
}

async function callGemini(aiConfig, userMessage, images) {
  const model = aiConfig.model || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${aiConfig.apiKey}`;
  const parts = [
    { text: userMessage },
    ...(images || []).map(img => ({
      inlineData: { mimeType: img.mimeType, data: img.data },
    })),
  ];
  const resp = await axios.post(
    url,
    {
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ parts }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 45000,
    }
  );
  return resp.data.candidates[0].content.parts[0].text;
}

// ─────────────────────────────────────────────
// 主导出函数
// ─────────────────────────────────────────────

async function generateContent(aiConfig, record) {
  if (!aiConfig || !aiConfig.apiKey) {
    throw new Error('AI 写作未配置 API Key');
  }
  if (!record.topic) {
    throw new Error('笔记主题为空，无法生成内容');
  }

  const baseUserMessage = buildUserMessage(record);
  // 不发图片给 AI：图片 base64 体积大（8 张 ≈ 16MB），中转服务处理耗时长且不稳定，
  // 纯文字主题已足够生成标题/正文/标签，去掉图片后响应更快速稳定。
  const totalImages = (record.imagePaths || []).length;
  const images = []; // 始终不发图片
  const sentToAi = 0;

  const provider = aiConfig.provider || 'openai';
  // 三个 provider 都共用 callAiWithRetry 这一套超时/网络抖动重试逻辑
  // (callOpenAI 内部已有的 response_format 降级与本层重试不冲突)
  async function callProviderOnce(userMessage) {
    if (provider === 'anthropic') {
      return callAiWithRetry(() => callAnthropic(aiConfig, userMessage, images));
    } else if (provider === 'gemini') {
      return callAiWithRetry(() => callGemini(aiConfig, userMessage, images));
    }
    return callAiWithRetry(() => callOpenAI(aiConfig, userMessage, images));
  }

  const platform = determinePlatform(record);
  // 红线④配套件回查需要的清单：由调用方在 record 上带 availableArtifacts（查资产库后传入）。
  // 不带时 validateGenerated 对提到配套件的正文一律 fail-closed，见该函数注释。
  const availableArtifacts = Array.isArray(record.availableArtifacts) ? record.availableArtifacts : undefined;

  let rawText = await callProviderOnce(baseUserMessage);
  let parsed = parseAiResponse(rawText);
  let violations = validateGenerated(parsed, platform, availableArtifacts);

  if (violations.length > 0) {
    // 机械校验不过：把违规项反馈进 user prompt，重试 1 次
    const retryMessage = `${baseUserMessage}\n\n上一次生成未通过校验，请修正以下问题后重新生成完整 JSON：\n${violations.map(v => `- ${v}`).join('\n')}`;
    rawText = await callProviderOnce(retryMessage);
    parsed = parseAiResponse(rawText);
    violations = validateGenerated(parsed, platform, availableArtifacts);
    if (violations.length > 0) {
      throw new Error(`AI 生成内容未通过校验（重试后仍不合规）：${violations.join('；')}`);
    }
  }

  // _meta 字段供调用方判断"AI 实际看到了多少张图",用户素材超过 IMAGE_MAX_COUNT 时
  // 调用方可以据此提示「AI 仅参考了前 N 张」
  return {
    ...parsed,
    _meta: {
      totalImages,
      sentToAi,
      truncated: totalImages > sentToAi,
    },
  };
}

// 测试连接：发一个最简短的请求验证 key 是否有效
async function testConnection(aiConfig) {
  if (!aiConfig || !aiConfig.apiKey) {
    throw new Error('未填写 API Key');
  }
  const provider = aiConfig.provider || 'openai';
  const testRecord = {
    topic: '测试',
    attachments: [],
    xiaohongshuAccount: '测试账号',
    douyinAccount: '',
  };
  // 用一个极短的 prompt 测试，只检查连通性
  const shortConfig = {
    ...aiConfig,
    model: aiConfig.model,
  };
  // 直接调用各 provider 的一个最简请求
  if (provider === 'anthropic') {
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: shortConfig.model || 'claude-3-5-haiku-20241022',
        max_tokens: 10,
        messages: [{ role: 'user', content: '请回复"OK"' }],
      },
      {
        headers: {
          'x-api-key': shortConfig.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );
    return { ok: true, model: resp.data.model };
  } else if (provider === 'gemini') {
    const model = shortConfig.model || 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${shortConfig.apiKey}`;
    const resp = await axios.post(
      url,
      { contents: [{ parts: [{ text: '请回复"OK"' }] }], generationConfig: { maxOutputTokens: 10 } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return { ok: true, model };
  } else {
    const baseUrl = (shortConfig.apiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const resp = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model: shortConfig.model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: '请回复"OK"' }],
        max_tokens: 10,
      },
      {
        headers: {
          Authorization: `Bearer ${shortConfig.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );
    return { ok: true, model: resp.data.model };
  }
}

module.exports = { generateContent, testConnection, validateGenerated };
