const axios = require('axios');

// ─────────────────────────────────────────────
// System Prompt（硬编码，与用户确认的版本一致）
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `你是一个帮教师撰写小红书/抖音平台发布内容的助手。

**任务**
读取素材字段和笔记主题，一次性生成标题、正文、标签三项内容。
如果素材字段为空或无实质内容，不生成任何输出，直接返回空白。

---

**平台判断规则**
- 小红书字段不为空：按小红书风格生成，标签不超过10个
- 抖音字段不为空：按抖音风格生成，标签不超过5个
- 两个字段同时存在：根据当前发布平台选择对应写法
- 平台字段为空或无法判断：默认按小红书生成，标签不超过10个

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
> 听说《童年的水墨画》这样上，思路真的很清晰

公式四：**年级册别 ＋ 《课文名》＋ 这样讲/上 ＋ 结果**（普通授课/公开课通用）
> 四下《母鸡》这样讲，被夸抓住了重点
> 四下《母鸡》第一课时这样备，重点更容易讲透

公开课/磨课类优先用公式一、二；普通授课类优先用公式三、四。

**填词规则**

过程词：磨课三次、磨了三次、磨了N次课

认可词（放句尾）：被教研员夸了、被教研员夸爆了、被教研员夸脱颖而出、被老师追着要、被夸抓住了重点

发现词：突然发现、听说

结果词：思路好清晰啊、思路真的很清晰、被夸爆了、太有巧思了、有重点有深度、重点更容易讲透

课文名较长时（书名本身超过6字），结果词优先选较短的，如"思路很清晰""被夸了""有深度""讲透了"，确保总字数控制在20字以内。

课文名必须带书名号，可在书名号前加年级册别，如"四下《母鸡》"。

**禁用**
- 不用"帮你""让你"——破坏分享视角
- 不用文件名式表达：课件资料合集、备课资源整理
- 不堆夸张词：绝了、天花板、闭眼入、太炸了

**格式**
- 总长度12—20字
- 最多1个符号（✅🔥👏），不叠加
- 最多1个感叹号

---

## 二、正文

**最重要的一条**
以真实教师分享备课感受的视角来写。重点说"用起来哪里省力、哪里值得注意"，不是介绍"资料里有什么"。

**撰写规则**
1. 内容必须以素材字段为主要依据，不得脱离随意发挥
2. 不描写课件视觉风格，不出现"国风排版""版式精美"等词
3. 不用强诱导表达：闭眼入、绝了、快码住、谁懂啊
4. 使用感受要克制真实，不夸大效果
5. 自然分行，每段围绕一个信息重点，不整段堆砌
6. 同一词或句式不重复出现，出现两次以上即有模板感
7. 搜索关键词自然融入，不机械堆砌

**语言规则**
- 不用：框架清晰、环节完整、符合课标、包含……、里面有……、整理了……
- 句子长短要有变化，不要每句节奏一样
- 可以有克制的主观判断，如"这块自己从头梳要花不少时间""这里比较容易忽略"
- 不要每段都写得过满，留一点呼吸感

**正确示例（照这个写）**

最近备统编版三年级语文下册《童年的水墨画》第一课时，这套设计用着还顺手。
导入用古诗水墨画猜意境切入，刚好贴合课文主题，不用额外找图配诗，省了不少功夫。字词部分把易错点都梳理清楚了，"染""墨"的书写误区直接点出，还用字理帮孩子理解记忆，这块自己从零梳理要花不少时间。
整个设计沿着赏"童年"诗画展的情境推进，两个初读活动接得很自然，不用再想活动怎么衔接。磨公开课的话这个结构直接能用，调细节就够了。

**错误示例（不要这样写）**

这份资料包含老舍作者资料拓展，全文标注了生字读音，整理了重点词语的讲解，特意点出了"恶"这个多音字的不同用法，还设计了找事例、画关键词的小组交流环节。整体教学流程清晰，环节完整，符合课标要求，适合日常授课和公开课使用。

❌ 错在哪：清单逻辑、介绍视角、套话总结，读起来像资料目录。

---

## 三、标签

**生成顺序（必须按顺序依次生成，前三类不得跳过）**
1. 课文名标签——必须有，如 #童年的水墨画
2. 年级学科标签——必须有，如 #三年级语文
3. 课时或资料类型标签——必须有，如 #第一课时 #教学设计 #逐字稿
4. 教学场景标签——按需补充，如 #公开课 #语文公开课
5. 教师人群标签——按需补充，如 #小学语文老师 #小学教师

前三类填满后，剩余名额再从第4、5类补充。

**撰写规则**
1. 标签必须紧扣笔记主题和素材内容，不得偏题
2. 少而准，不堆近义词，语义接近的标签不连续超过2个
3. 抽象大词如"教师成长""教研分享"可少量出现，不能作为主体
4. 标签简短、明确、可搜索，不写成长句
5. 内容明确是公开课可加"公开课""语文公开课"；不是公开课用"教学设计""教师备课"等中性标签代替

---

请严格按以下 JSON 格式输出，不要有任何其他内容（不要有 markdown 代码块标记）：
{"title":"...","description":"...","tags":["#标签1","#标签2"]}`;

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

function buildUserMessage(record) {
  const topic = record.topic || '';
  const attachmentNames = (record.attachments || [])
    .map(a => a.name || a.file_name || a.filename || '')
    .filter(Boolean)
    .join('、');

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
    `笔记主题：${topic}`,
    `素材附件：${attachmentNames || '（暂无附件文件名）'}`,
    platformHint,
  ].join('\n');
}

function parseAiResponse(text) {
  // 尝试从响应中提取 JSON，兼容 AI 有时多余换行或 markdown 代码块
  let cleaned = text.trim();
  // 去掉可能的 ```json ... ``` 包裹
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const result = JSON.parse(cleaned);
  if (!result.title || !result.description || !Array.isArray(result.tags)) {
    throw new Error('AI 返回格式不完整，缺少 title/description/tags');
  }
  return result;
}

// ─────────────────────────────────────────────
// Provider 调用实现
// ─────────────────────────────────────────────

async function callOpenAI(aiConfig, userMessage) {
  const baseUrl = (aiConfig.apiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const resp = await axios.post(
    `${baseUrl}/chat/completions`,
    {
      model: aiConfig.model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${aiConfig.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );
  return resp.data.choices[0].message.content;
}

async function callAnthropic(aiConfig, userMessage) {
  const resp = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: aiConfig.model || 'claude-3-5-haiku-20241022',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    },
    {
      headers: {
        'x-api-key': aiConfig.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );
  return resp.data.content[0].text;
}

async function callGemini(aiConfig, userMessage) {
  const model = aiConfig.model || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${aiConfig.apiKey}`;
  const resp = await axios.post(
    url,
    {
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ parts: [{ text: userMessage }] }],
      generationConfig: { temperature: 0.7 },
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000,
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
  let rawText;

  const provider = aiConfig.provider || 'openai';
  if (provider === 'anthropic') {
    rawText = await callAnthropic(aiConfig, userMessage);
  } else if (provider === 'gemini') {
    rawText = await callGemini(aiConfig, userMessage);
  } else {
    rawText = await callOpenAI(aiConfig, userMessage);
  }

  return parseAiResponse(rawText);
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
