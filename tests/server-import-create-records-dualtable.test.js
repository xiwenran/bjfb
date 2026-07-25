// HTTP 层验证：/api/import/create-records 在双表模式下按记录的
// xiaohongshuAccount/douyinAccount 路由到小红书表/抖音表，且残留字段不写入。
// 与 tests/server-import-create-records.test.js 的单表用例互补（那边验证旧版单表零行为变化）。
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tempRoot = path.join(os.tmpdir(), 'zhifa-server-import-dualtable-test');
fs.rmSync(tempRoot, { recursive: true, force: true });
process.env.NOTE_PUBLISHER_CONFIG_DIR = path.join(tempRoot, 'config');
process.env.NOTE_PUBLISHER_DATA_DIR = path.join(tempRoot, 'data');

const FeishuClient = require('../src/feishu.js');
const { startServer, stopServer, config } = require('../src/server.js');

const PORT = 3213;

function requestJson({ method, urlPath, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(raw || '{}') });
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

describe('server import integration (dual-table)', { concurrency: false }, () => {
  after(async () => {
    await stopServer();
  });

  test('create-records routes xiaohongshu/douyin records to their own table and drops leftover fields', { concurrency: false }, async (t) => {
    config.feishu = {
      appId: 'app',
      appSecret: 'secret',
      appToken: '', // legacy 单表刻意留空，证明双表模式下不会误用
      tableId: '',
      tables: {
        xiaohongshu: { appToken: 'XHS_APP', tableId: 'XHS_TABLE' },
        douyin: { appToken: 'DY_APP', tableId: 'DY_TABLE' },
      },
    };

    const createRecordCalls = []; // { fields, platform }
    const uploadCalls = []; // { platform }
    const originalGetTableFields = FeishuClient.prototype.getTableFields;
    const originalCreateTextField = FeishuClient.prototype.createTextField;
    const originalUploadLocalImagesToFeishu = FeishuClient.prototype.uploadLocalImagesToFeishu;
    const originalCreateRecord = FeishuClient.prototype.createRecord;
    const originalFindRecordByFingerprint = FeishuClient.prototype.findRecordByFingerprint;
    const originalGetRecordById = FeishuClient.prototype.getRecordById;

    FeishuClient.prototype.getTableFields = async () => ['导入指纹', '内容类型', '视频封面'];
    FeishuClient.prototype.createTextField = async () => {};
    FeishuClient.prototype.uploadLocalImagesToFeishu = async (paths, options) => {
      uploadCalls.push({ platform: options && options.platform });
      return (paths || []).map((_, i) => ({ fileToken: `ft_${i}` }));
    };
    FeishuClient.prototype.createRecord = async function (fields, platform) {
      createRecordCalls.push({ fields, platform });
      return { recordId: `rec_${createRecordCalls.length}` };
    };
    FeishuClient.prototype.findRecordByFingerprint = async () => null;
    FeishuClient.prototype.getRecordById = async (recordId) => ({ record_id: recordId, fields: {} });

    await startServer({ port: PORT, host: '127.0.0.1', silent: true });
    t.after(async () => {
      FeishuClient.prototype.getTableFields = originalGetTableFields;
      FeishuClient.prototype.createTextField = originalCreateTextField;
      FeishuClient.prototype.uploadLocalImagesToFeishu = originalUploadLocalImagesToFeishu;
      FeishuClient.prototype.createRecord = originalCreateRecord;
      FeishuClient.prototype.findRecordByFingerprint = originalFindRecordByFingerprint;
      FeishuClient.prototype.getRecordById = originalGetRecordById;
    });

    const response = await requestJson({
      method: 'POST',
      urlPath: '/api/import/create-records',
      body: {
        dryRun: false,
        records: [
          {
            noteKey: '专题A/xhs-001',
            topic: '专题A',
            images: [{ name: '1.png', path: '/tmp/1.png', size: 123 }],
            xiaohongshuAccount: '小红书账号A',
            douyinAccount: '',
          },
          {
            noteKey: '专题A/dy-001',
            topic: '专题A',
            images: [{ name: '1.png', path: '/tmp/1.png', size: 123 }],
            xiaohongshuAccount: '',
            douyinAccount: '抖音账号B',
          },
        ],
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.results[0].status, 'success');
    assert.equal(response.body.results[1].status, 'success');

    assert.equal(createRecordCalls.length, 2);
    assert.equal(createRecordCalls[0].platform, 'xiaohongshu');
    assert.equal(createRecordCalls[1].platform, 'douyin');

    assert.equal(uploadCalls.length, 2);
    assert.equal(uploadCalls[0].platform, 'xiaohongshu');
    assert.equal(uploadCalls[1].platform, 'douyin');

    // fields 组装阶段本身就只在对应平台分支里写各自账号字段（server.js Step 5），
    // 这里再次确认残留字段（对方平台账号）没有混入 createRecord 收到的 fields。
    assert.equal(createRecordCalls[0].fields['小红书账号'], '小红书账号A');
    assert.ok(!('抖音账号' in createRecordCalls[0].fields) || createRecordCalls[0].fields['抖音账号'] === '');
    assert.equal(createRecordCalls[1].fields['抖音账号'], '抖音账号B');
    assert.ok(!('小红书账号' in createRecordCalls[1].fields) || createRecordCalls[1].fields['小红书账号'] === '');
  });
});
