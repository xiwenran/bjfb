const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const { generateContent } = require('../src/ai-writer.js');


test('generateContent preserves real line breaks and independent tag fields with a stubbed provider', async () => {
  const originalPost = axios.post;
  const stubbedResult = {
    title: '北师大四上数学《乘法》课件梳理',
    description:
      '🧭北师大四上数学乘法课件\n' +
      '卫星运行时间和观众数量两类题放在一起对照\n\n' +
      '📚先看大数乘法的算理怎么说\n' +
      '再顺着例题做估算、笔算和计算工具的使用',
    tags: ['#北师大数学', '#四上数学', '#数学课件', '#乘法', '#教师备课'],
  };

  axios.post = async (url, body) => {
    assert.match(url, /\/chat\/completions$/);
    assert.match(body.messages[0].content, /内容换到下一块时空一行/);
    assert.match(body.messages[0].content, /标签集中保留在 tags 独立字段/);
    return {
      data: {
        choices: [{ message: { content: JSON.stringify(stubbedResult) } }],
      },
    };
  };

  try {
    const result = await generateContent(
      { provider: 'openai', apiBaseUrl: 'https://stub.invalid/v1', apiKey: 'stub-only', model: 'stub-model' },
      {
        topic: '北师大四上数学乘法课件',
        noteTitle: '合成测试笔记',
        xiaohongshuAccount: '合成测试普通号',
      }
    );
    assert.equal(result.description, stubbedResult.description);
    assert.deepEqual(result.tags, stubbedResult.tags);
    assert.ok(!result.description.includes('#北师大数学'));
  } finally {
    axios.post = originalPost;
  }
});
