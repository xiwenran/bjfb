const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zhifa-image-validation-'));
const configDir = path.join(tempRoot, 'config');
const dataDir = path.join(tempRoot, 'data');
const fixtureDir = path.join(tempRoot, 'fixtures');
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(fixtureDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
  feishu: { appId: '', appSecret: '', appToken: '', tableId: '' },
  aiWriting: { enabled: false },
}), 'utf8');
process.env.NOTE_PUBLISHER_CONFIG_DIR = configDir;
process.env.NOTE_PUBLISHER_DATA_DIR = dataDir;

const fixtures = {
  png: path.join(fixtureDir, '1.png'),
  jpeg: path.join(fixtureDir, '2.jpg'),
  webp: path.join(fixtureDir, '3.webp'),
  sidecar: path.join(fixtureDir, '._1.jpg'),
  truncated: path.join(fixtureDir, '4.png'),
  badCover: path.join(fixtureDir, '0.jpg'),
  bmp: path.join(fixtureDir, '5.bmp'),
};

fs.writeFileSync(fixtures.png, Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
));
fs.writeFileSync(fixtures.jpeg, Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z',
  'base64'
));
fs.writeFileSync(fixtures.webp, Buffer.from(
  'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
  'base64'
));
fs.writeFileSync(fixtures.sidecar, Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02]));
fs.writeFileSync(fixtures.truncated, Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]));
fs.writeFileSync(fixtures.badCover, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
fs.writeFileSync(fixtures.bmp, Buffer.from([0x42, 0x4d, 0x00, 0x00]));

const FeishuClient = require('../src/feishu.js');
const aiWriter = require('../src/ai-writer.js');
let aiGenerateCalls = 0;
aiWriter.generateContent = async () => {
  aiGenerateCalls++;
  throw new Error('simulated AI failure');
};
const { startServer, stopServer, config } = require('../src/server.js');

let port = 0;
let uploadCalls = [];
let createRecordCount = 0;
const completeContent = {
  title: '四年级上册乘法课件笔记',
  description:
    '🧭四年级上册乘法课件围绕算理与计算步骤展开\n' +
    '从情境问题进入，梳理估算、列式和竖式计算之间的关系\n\n' +
    '📚页面按知识点、例题和课堂练习依次组织\n' +
    '讲解时可以逐步展示，让学生边观察边说清每一步的依据',
  tags: ['#四年级数学', '#数学课件', '#乘法计算', '#课堂练习', '#教师备课'],
};

function requestJson(body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/import/create-records',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(raw || '{}') });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function image(name, filePath) {
  return { name, path: filePath, size: fs.statSync(filePath).size };
}

after(async () => {
  await stopServer();
});

test('create-records decodes pixels before any upload and preserves image error semantics', { concurrency: false }, async (t) => {
  config.feishu = { appId: 'test', appSecret: 'test', appToken: 'test', tableId: 'test' };
  config.aiWriting = { enabled: false };

  const originals = {
    getTableFields: FeishuClient.prototype.getTableFields,
    createTextField: FeishuClient.prototype.createTextField,
    uploadLocalImagesToFeishu: FeishuClient.prototype.uploadLocalImagesToFeishu,
    createRecord: FeishuClient.prototype.createRecord,
    findRecordByFingerprint: FeishuClient.prototype.findRecordByFingerprint,
    getRecordById: FeishuClient.prototype.getRecordById,
  };
  FeishuClient.prototype.getTableFields = async () => ['导入指纹', '内容类型', '图片'];
  FeishuClient.prototype.createTextField = async () => {};
  FeishuClient.prototype.uploadLocalImagesToFeishu = async paths => {
    uploadCalls.push([...paths]);
    return paths.map((_, index) => ({ fileToken: `token_${index}` }));
  };
  FeishuClient.prototype.createRecord = async () => ({ recordId: `record_${++createRecordCount}` });
  FeishuClient.prototype.findRecordByFingerprint = async () => null;
  FeishuClient.prototype.getRecordById = async recordId => ({ record_id: recordId, fields: {} });
  t.after(() => {
    Object.assign(FeishuClient.prototype, originals);
  });

  const serverInfo = await startServer({ port: 0, host: '127.0.0.1', silent: true });
  port = serverInfo.port;

  const normal = await requestJson({
    dryRun: true,
    records: [{
      noteKey: 'images/normal',
      topic: '图片测试',
      ...completeContent,
      images: [image('1.png', fixtures.png), image('2.jpg', fixtures.jpeg), image('3.webp', fixtures.webp)],
      xiaohongshuAccount: '测试账号',
    }],
  });
  assert.equal(normal.statusCode, 200);
  assert.equal(normal.body.results[0].status, 'preview');

  uploadCalls = [];
  const sidecarMixed = await requestJson({
    records: [{
      noteKey: 'images/sidecar',
      topic: '图片测试',
      ...completeContent,
      images: [image('1.png', fixtures.png), image('._1.jpg', fixtures.sidecar)],
      xiaohongshuAccount: '测试账号',
    }],
  });
  assert.equal(sidecarMixed.body.results[0].status, 'success', JSON.stringify(sidecarMixed.body));
  assert.deepEqual(uploadCalls, [[fixtures.png]]);
  assert.deepEqual(sidecarMixed.body.results[0].skippedFiles, [{ name: '._1.jpg', reason: 'dotfile' }]);

  uploadCalls = [];
  const truncatedMixed = await requestJson({
    records: [
      {
        noteKey: 'images/valid-record',
        topic: '图片测试',
        ...completeContent,
        images: [image('1.png', fixtures.png)],
        xiaohongshuAccount: '测试账号',
      },
      {
        noteKey: 'images/truncated-record',
        topic: '图片测试',
        ...completeContent,
        images: [image('1.png', fixtures.png), image('4.png', fixtures.truncated)],
        xiaohongshuAccount: '测试账号',
      },
    ],
  });
  assert.equal(truncatedMixed.body.results[0].status, 'success');
  assert.equal(truncatedMixed.body.results[1].status, 'failed');
  assert.equal(truncatedMixed.body.results[1].reason, 'invalid_images');
  assert.deepEqual(uploadCalls, [[fixtures.png]]);

  uploadCalls = [];
  const dryRunTruncated = await requestJson({
    dryRun: true,
    records: [{
      noteKey: 'images/truncated-preview',
      topic: '图片测试',
      ...completeContent,
      images: [image('1.png', fixtures.png), image('4.png', fixtures.truncated)],
      xiaohongshuAccount: '测试账号',
    }],
  });
  assert.equal(dryRunTruncated.body.results[0].status, 'failed');
  assert.equal(dryRunTruncated.body.results[0].reason, 'invalid_images');
  assert.deepEqual(uploadCalls, []);

  const allInvalid = await requestJson({
    records: [{
      noteKey: 'images/all-invalid',
      topic: '图片测试',
      ...completeContent,
      images: [image('4.png', fixtures.truncated)],
      xiaohongshuAccount: '测试账号',
    }],
  });
  assert.equal(allInvalid.body.results[0].status, 'failed');
  assert.equal(allInvalid.body.results[0].reason, 'no_valid_images');
  assert.deepEqual(uploadCalls, []);

  const badCover = await requestJson({
    records: [{
      noteKey: 'images/bad-cover',
      topic: '图片测试',
      ...completeContent,
      images: [image('0.jpg', fixtures.badCover), image('1.png', fixtures.png)],
      xiaohongshuAccount: '测试账号',
    }],
  });
  assert.equal(badCover.body.results[0].status, 'failed');
  assert.equal(badCover.body.results[0].reason, 'cover_filtered');
  assert.deepEqual(uploadCalls, []);

  config.aiWriting = { enabled: true, apiKey: 'test-key', provider: 'openai' };
  aiGenerateCalls = 0;
  const aiFailure = await requestJson({
    records: [{
      noteKey: 'images/ai-failure',
      topic: '图片测试',
      images: [image('1.png', fixtures.png)],
      xiaohongshuAccount: '测试账号',
    }],
  });
  assert.equal(aiFailure.body.results[0].status, 'failed');
  assert.equal(aiFailure.body.results[0].reason, 'ai_error');
  assert.equal(aiGenerateCalls, 1);
  assert.deepEqual(uploadCalls, []);

  aiGenerateCalls = 0;
  const incompletePrefill = await requestJson({
    records: [{
      noteKey: 'images/incomplete-prefill',
      topic: '图片测试',
      title: '只有标题',
      description: '',
      tags: [],
      images: [image('1.png', fixtures.png)],
      xiaohongshuAccount: '测试账号',
    }],
  });
  assert.equal(incompletePrefill.body.results[0].status, 'failed');
  assert.equal(incompletePrefill.body.results[0].reason, 'ai_error');
  assert.equal(aiGenerateCalls, 1);
  assert.deepEqual(uploadCalls, []);

  config.aiWriting = { enabled: false };
  aiGenerateCalls = 0;
  const disabledAiIncompletePrefill = await requestJson({
    records: [{
      noteKey: 'images/incomplete-prefill-ai-disabled',
      topic: '图片测试',
      title: '只有标题',
      description: '',
      tags: [],
      images: [image('1.png', fixtures.png)],
      xiaohongshuAccount: '测试账号',
    }],
  });
  assert.equal(disabledAiIncompletePrefill.body.results[0].status, 'failed');
  assert.equal(disabledAiIncompletePrefill.body.results[0].reason, 'content_incomplete');
  assert.equal(aiGenerateCalls, 0);
  assert.deepEqual(uploadCalls, []);

  const invalidPrefill = await requestJson({
    records: [{
      noteKey: 'images/invalid-prefill',
      topic: '图片测试',
      title: '格式不合格但字段非空',
      description: '正文只有一行，没有内容块间隔。',
      tags: ['#测试'],
      images: [image('1.png', fixtures.png)],
      xiaohongshuAccount: '测试账号',
    }],
  });
  assert.equal(invalidPrefill.body.results[0].status, 'failed');
  assert.equal(invalidPrefill.body.results[0].reason, 'content_invalid');
  assert.deepEqual(uploadCalls, []);

  const unsupportedBmp = await requestJson({
    records: [{
      noteKey: 'images/unsupported-bmp',
      topic: '图片测试',
      ...completeContent,
      images: [image('5.bmp', fixtures.bmp)],
      xiaohongshuAccount: '测试账号',
    }],
  });
  assert.equal(unsupportedBmp.body.results[0].status, 'failed');
  assert.equal(unsupportedBmp.body.results[0].reason, 'unsupported_image_format');
  assert.deepEqual(unsupportedBmp.body.results[0].skippedFiles, [{
    name: '5.bmp',
    reason: 'unsupported_image_format',
    format: 'bmp',
  }]);
  assert.deepEqual(uploadCalls, []);
});
