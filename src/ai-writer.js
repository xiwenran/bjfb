const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// System Prompt（硬编码，与用户确认的版本一致）
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `你是一个帮教师撰写小红书/抖音平台发布内容的助手。

**任务**
根据笔记主题，一次性生成标题、正文、标签三项内容。
title、description、tags 三项都必须有实质内容，不得为空字符串或空数组。

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

**标题双层结构（权威规则，必须优先套用；下方公式一~十四是钩子层的选材参考，最终标题都要按本节的层级和字数规则重新组装，不能只套公式不套双层结构）**

标题由两层拼接而成：**搜索词层 + 钩子层**。

搜索词层（三类词都要覆盖，缺一类都会影响搜索命中）：
1. 系列词——笔记主题的公共系列前缀，如"七升八英语""四下语文"；主题没有系列前缀时，改用课文名或资料主题词代替（如《母鸡》）。
2. 资料词——资料形态本身，如"讲义""笔记""一张图""复习清单"；非课件资料类主题（如家长会、班级管理经验分享）资料词可换成同类内容词，如"经验""复盘""要点"。
3. 细分主题词——具体知识点或章节，可压缩表达，如"名代形情态""U1"。

钩子层（必须从下方封闭菜单中选 1 个，可轻度改写缩短，但不得自创新的钩子语义）：
①备课少熬一晚　②开学第一讲不慌　③新接班先收好　④板书思路都在这
⑤衔接课备课不愁　⑥一页讲透省时间　⑦摸底考命题参考　⑧晨读自习能用上

同一批次（同一次生成的多篇）同一个钩子最多用 2 次，且不能相邻（中间至少隔 1 篇用别的钩子）。

字数不够 20 字时，按以下优先级取舍（先砍后面的）：系列词 > 资料词 > 细分主题词（可压缩） > 钩子（可缩短，不能整个删掉）。

英文课题/单元名在标题里一律压缩为编号形式，如"U1"，不写英文全名；英文全名放到正文首行。

**字数（硬约束，全文唯一权威表述，其他位置如有冲突以此处为准）**：
16-20 字为主，硬边界 10-20 字，不得少于 10 字、不得超过 20 字；emoji 计 1 字。

**emoji（硬约束）**：
每条标题必须带恰好 1 个 emoji，仅限以下白名单单码点：📌 🔥 ✅ 💡 ✨ 📝；放在句首或钩子前；不与感叹号同时使用。

**标点（硬约束）**：标题内标点符号最多 1 个（不含书名号《》和 emoji）。

**双层结构示例（平淡版 → 双层版）**：
- "七升八英语动词时态讲义整理" → "📌七升八英语动词时态讲义，备课少熬一晚"
- "三年级语文第一单元复习资料" → "📌三下语文U1复习清单，一页讲透省时间"
- "新接班班主任带班经验分享" → "📌新接班带班笔记，新接班先收好"

---

**以下公式一~十四是钩子层的选材参考**（帮助判断"这条内容该往哪个情绪/结果方向走"），最终标题仍必须按上方双层结构组装、并服从上方字数与 emoji 硬约束：

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
- 字数与 emoji 以「标题双层结构」一节的硬约束为准（不在此重复数值）
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

字数/emoji 仍按标题双层结构一节的硬约束执行（16-20字为主，硬边界10-20字，恰好1个白名单emoji），此处不重复列数值。

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

**钩子选材参考（仅用于判断内容适合哪种情绪/结果方向，最终仍要落到标题双层结构一节的封闭钩子菜单①~⑧）**

先判断主题的内容戏剧性，再决定钩子层该偏"效率省时"还是"心态安稳"：

| 戏剧性程度 | 主题特征 | 推荐钩子层方向（对应封闭菜单） |
|---|---|---|
| 高戏剧性 | 剧本杀、密室逃脱、辩论课、班级矛盾处理、家长投诉处理、强冲突场景 | ③新接班先收好 / ⑦摸底考命题参考 |
| 低戏剧性（高实用性） | 暑假作业布置、期末复习清单、常规通知、资料合集、练习册 | ①备课少熬一晚 / ⑥一页讲透省时间 |
| 普通授课（中性） | 普通课文讲解、非公开课日常教学 | ④板书思路都在这 / ⑤衔接课备课不愁 / ⑧晨读自习能用上 |

**禁用**
- 不用"帮你""让你"——破坏分享视角
- 不用文件名式表达：课件资料合集、备课资源整理、课堂可用、重点清楚、梳理完整、老师可参考
- 不堆夸张词：绝了、天花板、闭眼入、太炸了
- 不用引导互动类用词（关注我/私信我/评论区见/点赞收藏/点个赞/双击666/快码住/赶紧/别错过/一键三连/关注不迷路/直接用/直接套用/点击收藏/建议收藏/码住备用/赶紧收藏）——与正文禁用词清单共用同一份

标题的字数、emoji、标点等格式硬约束统一见"标题双层结构"一节，此处不重复列数值。

---

## 二、正文

**核心要求**

正文必须撰写，不允许留空（description 不得为空字符串）。图片仍是主体内容，正文按下方排版规则做搜索命中和信息补充。

**排版（小红书换行风格，硬约束）**
- 3-5 行，每行行首放 1 个 emoji（📌📝✅💡🔥，同一条正文内尽量错开使用），行与行之间用两个字符 \n 分隔（JSON 字符串里写 \n，不要写真实换行）。
- 首行必须包含系列词；主题含英文课题/单元名时，首行必须写出英文全名（如 "Unit 1 Happy Holiday"），保证英文关键词也能被搜索命中。
- 中间行写资料内容本身：讲了什么、覆盖哪些知识点或环节。
- 末行收尾，落在老师的收益上（备课省时间、新接班不慌等，呼应标题钩子方向，不必逐字重复标题）。
- 总字数 50-150 字（emoji 计 1 字，与标题口径一致）。

**绝对禁用**

不写任何引导互动、催促收藏的词语，也不出现平台敏感词；**标题同样禁止使用下方引导性用词清单**（如"直接用""直接套用"）。

**引导性用词**（出现即违规，标题和正文均适用）
关注我、私信我、评论区见、点赞收藏、点个赞、双击666、
快码住、赶紧、别错过、一键三连、关注不迷路、
直接用、直接套用、点击收藏、建议收藏、码住备用、赶紧收藏

**平台敏感词**（出现即违规）
微信、wx、加我、v我、购买、下单、链接、二维码、
免费领取、低价、白嫖、带货、佣金、分销、扫码

**写法示例（照这个写）**

标题："📌七升八英语U1时态讲义，备课少熬一晚"
正文：
📌七升八英语Unit 1 Grammar Focus 动词时态讲义\n📝整理了一般现在时与一般过去时的对比讲解和易错点\n✅配套例句和课堂练习，可直接展示\n🔥新接班或衔接课备课，这份能省下不少时间

标题："📌四下《母鸡》教学讲义，板书思路都在这"
正文：
📌统编版四年级下册《母鸡》第一课时\n📝导入环节用作者情感变化切入，梳理了"欺侮""如怨如诉"等重点词\n✅整体教学流程按情境推进，问题设计有梯度\n💡课堂直接可用，备课能省不少时间

**不要这样写**（清单罗列 + 套话总结，无分行无emoji）

这份资料包含老舍作者资料拓展，全文标注了生字读音，整理了重点词语的讲解。整体流程清晰，环节完整，符合课标要求，适合日常授课和公开课使用。

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
4. 字段顺序固定：title → description → tags → hook → charCount
5. hook 字段填标题实际使用的钩子编号或原文（如 "①备课少熬一晚"），charCount 字段填标题的总字数（含emoji，数字类型，用于自证是否落在10-20区间）；这两个字段仅供校验使用，不会写入飞书

正确示例——课文/课件类：
{"title":"📌四下《母鸡》讲义，一页讲透省时间","description":"📌统编版四年级下册《母鸡》第一课时\n📝导入环节用作者情感变化切入，梳理了重点词\n✅问题设计有梯度，整体流程按情境推进\n💡课堂直接可用，备课能省不少时间","tags":["#母鸡","#四年级语文","#第一课时","#小学语文","#教学设计"],"hook":"⑥一页讲透省时间","charCount":17}

正确示例——家长会/班主任经验类：
{"title":"📌新接班带班笔记，新接班先收好","description":"📌新接班班主任带班经验整理\n📝覆盖开学第一周流程、常规建立、家长沟通话术\n✅按周梳理，照着做就能上手\n🔥新接班压力大，这份能帮你少走弯路","tags":["#班主任","#新接班","#班级管理","#小学班主任","#家校共育"],"hook":"③新接班先收好","charCount":16}`;

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
    '标题要求：按「搜索词层+钩子层」双层结构组装，16-20字为主，硬边界10-20字，恰好1个白名单emoji，钩子从封闭菜单①~⑧中选。',
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
// 机械校验：与 SYSTEM_PROMPT 的标题双层结构 / 正文排版 / 标签规范一一对应
// ─────────────────────────────────────────────

// 标题/正文行首 emoji 白名单，单码点，与 SYSTEM_PROMPT 保持一致
const TITLE_EMOJI_WHITELIST = ['📌', '🔥', '✅', '💡', '✨', '📝'];

// 标题禁用词：SYSTEM_PROMPT「禁用」小节 + 正文「引导性用词」清单（标题同样禁用引导词）
const TITLE_BANNED_WORDS = [
  '帮你', '让你',
  '课件资料合集', '备课资源整理', '课堂可用', '重点清楚', '梳理完整', '老师可参考',
  '绝了', '天花板', '闭眼入', '太炸了',
  '关注我', '私信我', '评论区见', '点赞收藏', '点个赞', '双击666',
  '快码住', '赶紧', '别错过', '一键三连', '关注不迷路',
  '直接用', '直接套用', '点击收藏', '建议收藏', '码住备用', '赶紧收藏',
];

// 标点符号集合（不含书名号《》和 emoji）
const PUNCT_REGEX = /[，。！？、；：""''（）\-—,.!?;:()]/g;

function countCodepoints(str) {
  return Array.from(String(str || '')).length;
}

function countWhitelistEmoji(str) {
  return Array.from(String(str || '')).filter(ch => TITLE_EMOJI_WHITELIST.includes(ch)).length;
}

// 统计任意 emoji/图形符号数量（用于检测标题里是否混入白名单外的 emoji）
function countAnyEmoji(str) {
  const matches = String(str || '').match(/\p{Extended_Pictographic}/gu);
  return matches ? matches.length : 0;
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

// 校验 AI 生成内容是否符合标题双层结构 / 正文排版 / 标签规范，返回违规项数组（空数组=通过）
function validateGenerated(content, platform) {
  const violations = [];
  const title = String(content?.title || '');
  const description = String(content?.description || '');
  const tags = Array.isArray(content?.tags) ? content.tags : [];

  // ── 标题 ──
  if (!title) {
    violations.push('标题为空');
  } else {
    const titleLen = countCodepoints(title);
    if (titleLen < 10 || titleLen > 20) {
      violations.push(`标题字数 ${titleLen} 不在 10-20 区间（含emoji计1字）`);
    }
    const whitelistEmojiCount = countWhitelistEmoji(title);
    const anyEmojiCount = countAnyEmoji(title);
    if (whitelistEmojiCount !== 1) {
      violations.push(`标题白名单emoji数量为 ${whitelistEmojiCount}，必须恰好1个（白名单：${TITLE_EMOJI_WHITELIST.join('')}）`);
    } else if (anyEmojiCount !== whitelistEmojiCount) {
      violations.push('标题含白名单外的emoji');
    }
    const punctMatches = title.match(PUNCT_REGEX);
    const punctCount = punctMatches ? punctMatches.length : 0;
    if (punctCount > 1) {
      violations.push(`标题标点符号 ${punctCount} 个，最多1个（不含书名号和emoji）`);
    }
    const hitBannedWord = TITLE_BANNED_WORDS.find(word => title.includes(word));
    if (hitBannedWord) {
      violations.push(`标题含禁用词「${hitBannedWord}」`);
    }
  }

  // ── 正文 ──
  if (!description.trim()) {
    violations.push('正文为空，正文必须撰写');
  } else {
    const descLen = countCodepoints(description);
    if (descLen < 50 || descLen > 150) {
      violations.push(`正文字数 ${descLen} 不在 50-150 区间`);
    }
    const lines = description.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 3) {
      violations.push(`正文分行数 ${lines.length}，至少需要3行（每行以 \\n 分隔）`);
    }
    const badLineIndex = lines.findIndex(line => {
      const first = Array.from(line)[0];
      return !TITLE_EMOJI_WHITELIST.includes(first);
    });
    if (badLineIndex >= 0) {
      violations.push(`正文第 ${badLineIndex + 1} 行行首不是白名单emoji`);
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

  let rawText = await callProviderOnce(baseUserMessage);
  let parsed = parseAiResponse(rawText);
  let violations = validateGenerated(parsed, platform);

  if (violations.length > 0) {
    // 机械校验不过：把违规项反馈进 user prompt，重试 1 次
    const retryMessage = `${baseUserMessage}\n\n上一次生成未通过校验，请修正以下问题后重新生成完整 JSON：\n${violations.map(v => `- ${v}`).join('\n')}`;
    rawText = await callProviderOnce(retryMessage);
    parsed = parseAiResponse(rawText);
    violations = validateGenerated(parsed, platform);
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
