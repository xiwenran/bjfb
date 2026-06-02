const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const http = require('http');

const tempRoot = path.join(os.tmpdir(), 'zhifa-server-import-test');
process.env.NOTE_PUBLISHER_CONFIG_DIR = path.join(tempRoot, 'config');
process.env.NOTE_PUBLISHER_DATA_DIR = path.join(tempRoot, 'data');

const FeishuClient = require('../src/feishu.js');
const { startServer, stopServer, config } = require('../src/server.js');

function requestJson({ method, urlPath, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3211,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(raw || '{}'),
          });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test('create-records should enforce trimmed account validation and keep single-platform behavior unchanged', { concurrency: false }, async (t) => {
  config.feishu = { appId: 'app', appSecret: 'secret', appToken: 'token', tableId: 'table' };

  let uploadCalls = 0;
  let createRecordCalls = 0;
  const createRecordFields = [];
  const originalGetTableFields = FeishuClient.prototype.getTableFields;
  const originalCreateTextField = FeishuClient.prototype.createTextField;
  const originalUploadLocalImagesToFeishu = FeishuClient.prototype.uploadLocalImagesToFeishu;
  const originalCreateRecord = FeishuClient.prototype.createRecord;

  FeishuClient.prototype.getTableFields = async () => ['导入指纹'];
  FeishuClient.prototype.createTextField = async () => {};
  FeishuClient.prototype.uploadLocalImagesToFeishu = async () => {
    uploadCalls += 1;
    return [{ fileToken: 'ft_1' }];
  };
  FeishuClient.prototype.createRecord = async (fields) => {
    createRecordCalls += 1;
    createRecordFields.push(fields);
    return { recordId: 'rec_1' };
  };

  await startServer({ port: 3211, host: '127.0.0.1', silent: true });
  t.after(async () => {
    await stopServer();
    FeishuClient.prototype.getTableFields = originalGetTableFields;
    FeishuClient.prototype.createTextField = originalCreateTextField;
    FeishuClient.prototype.uploadLocalImagesToFeishu = originalUploadLocalImagesToFeishu;
    FeishuClient.prototype.createRecord = originalCreateRecord;
  });

  const response = await requestJson({
    method: 'POST',
    urlPath: '/api/import/create-records',
    body: {
      dryRun: false,
      records: [{
        noteKey: '专题A/001',
        topic: '专题A',
        images: [{ name: '1.png', path: '/tmp/1.png', size: 123 }],
        xiaohongshuAccount: ' 小红书账号A ',
        douyinAccount: ' 抖音账号B ',
      }],
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.results[0].status, 'failed');
  assert.equal(response.body.results[0].reason, 'multiple_platform_accounts');
  assert.match(
    response.body.results[0].message,
    /同一条笔记不能同时填写小红书和抖音账号/
  );
  assert.equal(uploadCalls, 0);
  assert.equal(createRecordCalls, 0);

  const douyinOnlyResponse = await requestJson({
    method: 'POST',
    urlPath: '/api/import/create-records',
    body: {
      dryRun: false,
      records: [{
        noteKey: '专题A/002',
        topic: '专题A',
        images: [],
        xiaohongshuAccount: '   ',
        douyinAccount: '抖音账号B',
      }],
    },
  });

  assert.equal(douyinOnlyResponse.statusCode, 200);
  assert.equal(douyinOnlyResponse.body.results[0].status, 'success');
  assert.equal(douyinOnlyResponse.body.results[0].recordId, 'rec_1');
  assert.equal(createRecordCalls, 1);
  assert.equal(createRecordFields[0]['抖音账号'], '抖音账号B');
  assert.ok(!('小红书账号' in createRecordFields[0]) || createRecordFields[0]['小红书账号'] === '');

  const douyinOnlyWithEmptyXhsResponse = await requestJson({
    method: 'POST',
    urlPath: '/api/import/create-records',
    body: {
      dryRun: false,
      records: [{
        noteKey: '专题A/003',
        topic: '专题A',
        images: [],
        xiaohongshuAccount: '',
        douyinAccount: '抖音账号B',
      }],
    },
  });

  assert.equal(douyinOnlyWithEmptyXhsResponse.statusCode, 200);
  assert.equal(douyinOnlyWithEmptyXhsResponse.body.results[0].status, 'success');
  assert.equal(douyinOnlyWithEmptyXhsResponse.body.results[0].recordId, 'rec_1');
  assert.equal(createRecordCalls, 2);
  assert.equal(createRecordFields[1]['抖音账号'], '抖音账号B');
  assert.ok(!('小红书账号' in createRecordFields[1]) || createRecordFields[1]['小红书账号'] === '');

  const xiaohongshuOnlyResponse = await requestJson({
    method: 'POST',
    urlPath: '/api/import/create-records',
    body: {
      dryRun: false,
      records: [{
        noteKey: '专题A/004',
        topic: '专题A',
        images: [],
        xiaohongshuAccount: ' 小红书账号A ',
        douyinAccount: '   ',
      }],
    },
  });

  assert.equal(xiaohongshuOnlyResponse.statusCode, 200);
  assert.equal(xiaohongshuOnlyResponse.body.results[0].status, 'success');
  assert.equal(xiaohongshuOnlyResponse.body.results[0].recordId, 'rec_1');
  assert.equal(createRecordCalls, 3);
  assert.equal(createRecordFields[2]['小红书账号'], '小红书账号A');
  assert.ok(
    createRecordFields[2]['小红书发布渠道'] !== undefined &&
    createRecordFields[2]['小红书发布渠道'] !== null &&
    createRecordFields[2]['小红书发布渠道'] !== ''
  );
  assert.ok(!('抖音账号' in createRecordFields[2]) || createRecordFields[2]['抖音账号'] === '');

  const sameFolderNameDifferentPptTopicResponse = await requestJson({
    method: 'POST',
    urlPath: '/api/import/create-records',
    body: {
      dryRun: false,
      records: [
        {
          noteKey: '教务资料/期末家长会/001',
          topic: '教务资料',
          pptTopic: '期末家长会',
          images: [{ name: '1.png', path: '/tmp/1.png', size: 123 }],
          xiaohongshuAccount: '小红书账号A',
          douyinAccount: '',
        },
        {
          noteKey: '教务资料/暑假家长会/001',
          topic: '教务资料',
          pptTopic: '暑假家长会',
          images: [{ name: '1.png', path: '/tmp/1.png', size: 123 }],
          xiaohongshuAccount: '小红书账号A',
          douyinAccount: '',
        },
      ],
    },
  });

  assert.equal(sameFolderNameDifferentPptTopicResponse.statusCode, 200);
  assert.equal(sameFolderNameDifferentPptTopicResponse.body.results[0].status, 'success');
  assert.equal(sameFolderNameDifferentPptTopicResponse.body.results[1].status, 'success');
  assert.equal(createRecordCalls, 5);
  assert.notEqual(createRecordFields[3]['导入指纹'], createRecordFields[4]['导入指纹']);
});
