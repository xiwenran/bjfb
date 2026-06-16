const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// System Prompt（硬编码，与用户确认的版本一致）
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `你是一个帮教师撰写小红书/抖音平台发布内容的助手。

**任务**
根据笔记主题，一次性生成标题、正文、标签三项内容。
title 和 tags 必须有实质内容，不得为空字符串或空数组；description 可以留空（写空字符串 ""）。

---

**平台判断规则**
- 用户输入包含「发布平台：小红书」：按小红书风格生成，标签不超过10个
- 用户输入包含「发布平台：抖音」：按抖音风格生成，标签不超过5个
- 用户输入包含「发布平台：小红书和抖音均有」：按小红书风格生成，标签不超过10个
- 发布平台未指定：默认按小红书生成，标签不超过10个

---

**课型判断规则**
1. 先根据笔记主题判断内容属于哪类教学场景
2. 只有当笔记主题中明确包含以下关键词，标题才可以使用"公开课""磨课""教研"等表述：公开课、展示课、赛课、磨课、教研课、评优课、观摩课、汇报课
3. 不包含上述关键词，则按普通授课、日常教学、备课参考方向撰写
4. 不得为提升吸引力，擅自将普通授课内容写成公开课或磨课类标题

---

## 一、标题

**优先使用的四套公式**

公式一：**过程 ＋ 《课文名》＋ 这样上/讲 ＋ 结果**（公开课/磨课类）
> 磨课三次《母鸡》这样上，思路真的很清晰

公式二：**《课文名》＋ 这样讲/上 ＋ 外部认可**（公开课/磨课类）
> 《海上日出》公开课这样讲，被教研员夸了
> 《母鸡》公开课这样上，被教研员夸脱颖而出

公式三：**突然发现/听说 ＋ 《课文名》＋ 这样讲/上 ＋ 结果**（普通授课/公开课通用）
> 突然发现《母鸡》这样讲，思路好清晰啊
> 听说《童年的水墨画》这样上思路很清晰啊

公式四：**年级册别 ＋ 《课文名》＋ 这样讲/上 ＋ 结果**（普通授课/公开课通用）
> 四下《母鸡》这样讲，被夸抓住了重点
> 四下《母鸡》第一课时这样备，讲透了

公开课/磨课类只用公式一或二，不用公式三、四；普通授课类优先用公式三、四。

**课件标题先判断使用场景**

多数课件是给老师使用，不是给学生自学。标题不要只描述资料本身，而要写"老师怎么用 + 学生/家长/班级有什么变化"。

先按主题判断分类，再选择公式：

| 分类 | 标题核心 |
|---|---|
| 授课课件 | 这篇课文怎么讲，学生更懂 |
| 复习课件 | 这套复习怎么带，学生更清楚 |
| 家长会 | 这场会怎么讲，家长更听进去 |
| 主题班会 | 这个主题怎么开，学生有反应 |
| 班级管理 | 这个问题怎么处理，班级有变化 |
| 资料合集 | 老师为什么要保存，备课怎么省事 |

**结果对象必须正确**
- 授课课件、复习课件：结果对象优先是学生，如"学生一下就懂了""学生跟着梳理更清楚""学生更容易跟上"
- 家长会：结果对象优先是家长，如"家长真的听进去了"
- 主题班会：结果对象优先是学生，如"学生真的听进去了"
- 班级管理：结果对象优先是班级变化，如"班级有变化""纪律更稳"
- 资料合集：可以写老师收益，如"老师备课真的省很多事"

**课件/资料类专属公式**

公式五（授课课件）：**年级册别/课文名 + 这样讲/这样上 + 学生结果**
> 四下《母鸡》这样讲，学生一下就懂了
> 《童年的水墨画》这样上，学生更容易进课文

公式六（复习课件）：**年级学科 + 单元/册别 + 复习 + 学生结果**
> 三下语文第一单元复习，学生跟着梳理更清楚
> 三下语文第一单元复习，带学生这样过一遍
> 三下语文第一单元复习，知识点这样串起来

公式七（家长会）：**班主任/年级 + 这样开家长会 + 家长反应**
> 班主任这样开家长会，家长真的听进去了
> 期末家长会这样讲，家长真的听进去了

公式八（主题班会）：**这节/这个 + 主题班会 + 这样开 + 学生反应**
> 这节安全班会这样开，学生真的听进去了
> 这节自律班会这样开，学生真的有反应

公式九（班级管理）：**具体问题 + 反复提醒没用 + 可以这样做**
> 班级纪律反复提醒没用，可以试试这样做
> 学生总是拖拖拉拉，可以这样带一带

公式十（资料合集）：**这套资料 + 老师备课收益**
> 这套三下语文资料，老师备课真的省很多事
> 这套复习资料，老师期末备课能省不少事

**课件标题禁用资料说明词**

不要把以下词当标题结尾：课堂可用、重点清楚、梳理完整、板块清楚、老师可参考、上课可用、老师看完就懂、思路清晰、路线清楚。

这些词可以帮助判断资料质量，但不能单独作为标题吸引点。必须改成动作和结果，如"这样讲""这样带""这样开""学生更清楚""家长听进去了"。

**小红书真实标题风格补充（课件类优先级更高）**

标题对象是老师，不是学生自学用户。标题必须写出"老师为什么现在需要这套课件"，而不是介绍资料本身。

硬约束：
- 标题 16-20 字为主，最低 14 字；允许 1 个 emoji，但 emoji 不用来凑字数
- 必须包含具体教学/教务场景 + 情绪或结果钩子
- 不得只写"这套课件很清楚/很省心/更稳/更懂"这类平铺结论
- 同一批标题避免连续使用同一个句式

优先标题方向：
- 场景冲突：家长会上我说了某句话，家长安静/沉默/记笔记
- 反常识表达：别急着讲成绩/别再讲大道理，先讲状态/问题
- 课堂即时反馈：某知识点这样拆，学生终于能跟上
- 强节点压力：中考前、期末前、暑假前，老师最怕的场景
- 玩法类比：用熟悉事物讲抽象知识点，但不得编造图片中没有的玩法

示例：
- 家长会别急着讲成绩，先讲孩子状态
- 期末家长会这页，家长真的会安静
- 班会别再讲大道理，学生真的不爱听
- 暑假作业这样布置，家长少追问很多
- 宾语从句这样拆，学生终于不乱了

**笔记主题中没有明确课文名且不属于上述课件分类时**（家长会、班主任经验、育儿话题、班级管理、教师成长等）：

不套课文类公式，使用以下专属公式：

公式十一（爆款核心）：**场合 + 对比动作 + 强烈反应**
> 家长会上没讲大道理，家长都听进去了
> 那天家长会没讲道理，全班都安静了

公式十二（反直觉型）：**场合 + 颠覆认知的结论**
> 期中家长会上，别教育家长
> 期末家长会上，别讲大道理只讲重点

公式十三（揭秘型）：**我用一节XX，讲清楚了YY**
> 一节家长会，讲透了孩子拖拉的原因

公式十四（结果导向型）：**XX这样开/讲 + ZZ反应**
> 期末家长会这样开，家长都记笔记了
> 期中家长会这样讲，家长沉默了

仍遵守格式：10—20字，最多1个标点，1个emoji（可不加）。
**字数是硬约束：不得少于10字，不得超过20字，超出即违规，必须重新生成。**

**填词规则**

过程词：磨课三次、磨了三次、磨了N次课

认可词（放句尾）：被教研员夸了、被教研员夸爆了、被教研员夸脱颖而出、被老师追着要、被夸抓住了重点

发现词：突然发现、听说

结果词：思路好清晰啊、思路真的很清晰、被夸爆了、太有巧思了、有重点有深度、重点更容易讲透

课文名较长时（书名本身超过6字），结果词优先选较短的，如"思路很清晰""被夸了""有深度""讲透了"，确保总字数控制在20字以内。

课文名必须带书名号，可在书名号前加年级册别，如"四下《母鸡》"。

**同主题批量生成防雷同（多篇时强制执行）**

当同一主题（topic 相同）下生成多篇笔记标题时：
- 必须一次性为 N 篇生成 N 个角度不同的标题，不得复用同一公式超过 2 次（N ≥ 3 时公式三最多用 2 次，其余换其他公式）
- 任意两个标题的主干句子（去掉书名号内容、数字、过程词后的核心句式）不得完全相同
- 每篇切入角度不同：可从"教师视角、学生反应、教研认可、场景冲突、反直觉"等不同维度轮换
- 自检：把 N 个标题列出后检查有无连续重复的关键动词（如连续出现 3 个"这样讲"），有则替换为"这样上""这样备""这样带"等近义词

**钩子按内容戏剧性软匹配（所有篇数均适用）**

先判断主题的内容戏剧性，再选择钩子方向：

| 戏剧性程度 | 主题特征 | 推荐钩子方向 |
|---|---|---|
| 高戏剧性 | 剧本杀、密室逃脱、辩论课、班级矛盾处理、家长投诉处理、强冲突场景 | 可用情绪钩子：「家长当场沉默了」「全班安静了」「没想到学生反应这么大」 |
| 低戏剧性（高实用性） | 暑假作业布置、期末复习清单、常规通知、资料合集、练习册 | 只用「具体化＋痛点共鸣」：「家长少追问很多」「备课省时 30 分钟」「学生跟得上」；禁止编造情绪冲突 |
| 普通授课（中性） | 普通课文讲解、非公开课日常教学 | 用「学生反应」或「清晰度」钩子：「思路好清晰」「学生一下就懂了」 |

**硬约束**：低戏剧性主题（作业布置/复习资料/通知类）禁止使用「家长沉默了」「全班安静」「震惊了」等强情绪表达——货不对板的夸张承诺会被用户识别为虚假内容。

**禁用**
- 不用"帮你""让你"——破坏分享视角
- 不用文件名式表达：课件资料合集、备课资源整理、课堂可用、重点清楚、梳理完整、老师可参考
- 不堆夸张词：绝了、天花板、闭眼入、太炸了

**格式（硬约束，违反即违规）**
- 总长度：**10—20字，不得超过20字，不得少于10字**
- 标点符号最多1个（不含书名号和emoji）
- emoji 最多1个，不与感叹号同时使用

---

## 二、正文

**核心要求**

正文是辅助性的，图片才是主体内容。正文只需点到即可，不需要展开写。

**写法（适用所有类型）**
- 最多写 2 句话，共不超过 50 字
- 可以完全留空（description 写空字符串 ""）
- 只说核心信息点，不展开分析，不写套话
- 不要铺垫、不要总结句、不要感受性语言

**A. 课文/教案/课件类**：写课文名 + 年级 + 1 句说明内容重点即可。
**B. 家长会/班主任经验类**：写 1 句提炼核心观点，或直接留空。
**C. 备课资料类**：写资料类型 + 适用年级，其余留空。

**绝对禁用**

不写任何引导互动、催促收藏的词语，也不出现平台敏感词。

**引导性用词**（出现即违规）
关注我、私信我、评论区见、点赞收藏、点个赞、双击666、
快码住、赶紧、别错过、一键三连、关注不迷路、
直接用、直接套用、点击收藏、建议收藏、码住备用、赶紧收藏

**平台敏感词**（出现即违规）
微信、wx、加我、v我、购买、下单、链接、二维码、
免费领取、低价、白嫖、带货、佣金、分销、扫码

**写法示例（照这个写）**

统编版三年级语文下册《童年的水墨画》第一课时。
导入环节用古诗水墨画意境切入，与课文主题衔接。
字词部分梳理了"染""墨"等易错字的书写要点，结合字理辅助记忆。
整体教学流程按情境推进，初读活动设计了两个层次，课文感知环节有结构化的问题设计。

**不要这样写**（清单罗列 + 套话总结）

这份资料包含老舍作者资料拓展，全文标注了生字读音，整理了重点词语的讲解。
整体流程清晰，环节完整，符合课标要求，适合日常授课和公开课使用。

---

## 三、标签

**A. 课文/教案/课件类标签顺序（前三类不得跳过）**
1. 课文名标签——必须有，如 #童年的水墨画
2. 年级学科标签——必须有，如 #三年级语文
3. 课时或资料类型标签——必须有，如 #第一课时 #教学设计 #逐字稿
4. 教学场景标签——内容明确是公开课才加，如 #公开课 #语文公开课；不是公开课用 #教学设计 #教师备课 等中性标签
5. 教师人群标签——按需补充，如 #小学语文老师 #小学教师

前三类填满后，剩余名额再从第4、5类补充。小红书最多10个，抖音最多5个。

**B. 家长会/班主任经验类标签顺序**
1. 场合标签——必须有，如 #家长会 #期中家长会 #期末家长会（按主题选一）
2. 身份标签——必须有，如 #班主任 #小学班主任
3. 主题标签——必须有，如 #家校共育 #家校沟通 #班主任工作
4. 补充标签——按需，如 #教育 #教师成长 #小学 #年级（如四年级）

按需标签仅在与笔记主题高度相关时添加，不默认全加。小红书最多10个，抖音最多5个。

**撰写规则**
1. 标签必须紧扣笔记主题，不得偏题
2. 少而准，不堆近义词，语义接近的标签不连续超过2个
3. 抽象大词如"教师成长""教研分享"可少量出现，不能作为主体
4. 标签简短、明确、可搜索，不写成长句

---

## 输出格式（严格遵守，违反即失败）

1. 只输出一行 JSON，不要任何其他内容——不要思考过程、不要解释、不要 <think> 标签、不要代码块（不要有 \`\`\` 标记）
2. description 内的换行用两个字符 \n 表示，不要直接回车换行
3. description 内如需引用文字，用中文引号「」，不要用英文双引号（英文双引号会破坏 JSON 结构）
4. 字段顺序固定：title → description → tags

正确示例——课文类：
{"title":"四下《母鸡》这样讲，思路好清晰啊","description":"统编版四年级下册《母鸡》第一课时，重点讲作者情感态度的前后变化。","tags":["#母鸡","#四年级语文","#第一课时","#小学语文","#教学设计"]}

正确示例——家长会类（正文可留空）：
{"title":"期末家长会上没讲大道理，家长都记笔记了","description":"","tags":["#家长会","#期末家长会","#班主任","#小学班主任","#家校共育","#班主任工作"]}

正确示例——家长会类（写1句）：
{"title":"五年级语文不是滑坡，是爬坡，家长会上讲透了","description":"五年级是爬坡期，阅读和作文要求都升级了，帮家长理清这个认知最重要。","tags":["#家长会","#期中家长会","#五年级","#班主任","#小学班主任","#家校共育"]}`;

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
    '标题要求：面向老师，16-20字为主，最低14字；写具体教学/教务场景和情绪或结果钩子，不要写成资料说明。',
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

  // description 允许为空字符串，只检查 title 和 tags
  if (!title || tags.length === 0) return null;
  return { title, description, tags };
}

function validateAiResult(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('AI 返回不是 JSON 对象');
  }
  // description 允许为空字符串，只要求 title 和 tags 有实质内容
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

  const userMessage = buildUserMessage(record);
  // 不发图片给 AI：图片 base64 体积大（8 张 ≈ 16MB），中转服务处理耗时长且不稳定，
  // 纯文字主题已足够生成标题/正文/标签，去掉图片后响应更快速稳定。
  const totalImages = (record.imagePaths || []).length;
  const images = []; // 始终不发图片
  const sentToAi = 0;
  let rawText;

  const provider = aiConfig.provider || 'openai';
  // 用 callAiWithRetry 包一层,超时/网络抖动/5xx 时重试 1 次,
  // 三个 provider 都共用这一套重试逻辑(callOpenAI 内部已有的 response_format 降级与本层重试不冲突)
  if (provider === 'anthropic') {
    rawText = await callAiWithRetry(() => callAnthropic(aiConfig, userMessage, images));
  } else if (provider === 'gemini') {
    rawText = await callAiWithRetry(() => callGemini(aiConfig, userMessage, images));
  } else {
    rawText = await callAiWithRetry(() => callOpenAI(aiConfig, userMessage, images));
  }

  const parsed = parseAiResponse(rawText);
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

module.exports = { generateContent, testConnection };
