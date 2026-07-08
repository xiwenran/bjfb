const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

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

  const closeIntervalResponse = await requestJson({
    method: 'POST',
    urlPath: '/api/import/create-records',
    body: {
      dryRun: false,
      records: [
        {
          noteKey: '专题A/too-close-1',
          topic: '专题A',
          images: [],
          publishTime: '2026-06-15 09:00',
          xiaohongshuAccount: '小红书账号A',
          douyinAccount: '',
        },
        {
          noteKey: '专题A/too-close-2',
          topic: '专题A',
          images: [],
          publishTime: '2026-06-15 10:00',
          xiaohongshuAccount: '小红书账号A',
          douyinAccount: '',
        },
      ],
    },
  });

  assert.equal(closeIntervalResponse.statusCode, 200);
  assert.equal(closeIntervalResponse.body.results.length, 2);
  assert.equal(closeIntervalResponse.body.results[0].status, 'success');
  assert.equal(closeIntervalResponse.body.results[1].status, 'success');
  assert.equal(createRecordCalls, 2);

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
  assert.equal(createRecordCalls, 3);
  assert.equal(createRecordFields[2]['抖音账号'], '抖音账号B');
  assert.ok(!('小红书账号' in createRecordFields[2]) || createRecordFields[2]['小红书账号'] === '');

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
  assert.equal(createRecordCalls, 4);
  assert.equal(createRecordFields[3]['抖音账号'], '抖音账号B');
  assert.ok(!('小红书账号' in createRecordFields[3]) || createRecordFields[3]['小红书账号'] === '');

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
  assert.equal(createRecordCalls, 5);
  assert.equal(createRecordFields[4]['小红书账号'], '小红书账号A');
  assert.ok(
    createRecordFields[4]['小红书发布渠道'] !== undefined &&
    createRecordFields[4]['小红书发布渠道'] !== null &&
    createRecordFields[4]['小红书发布渠道'] !== ''
  );
  assert.ok(!('抖音账号' in createRecordFields[4]) || createRecordFields[4]['抖音账号'] === '');

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
  assert.equal(createRecordCalls, 7);
  assert.notEqual(createRecordFields[5]['导入指纹'], createRecordFields[6]['导入指纹']);
});

test('skill_upload keeps 6 hour interval optional unless records constraints opt in', () => {
  const pythonCheck = `
import contextlib
import io
import json
import os
import tempfile

from scripts import skill_upload

payload = {
    "accounts": {"xiaohongshu": ["账号A"]},
    "timeWindows": {
        "regular": [{"date": "2026-06-15", "start": "09:00", "end": "12:00"}],
        "special": [],
    },
    "minSameAccountIntervalMinutes": 360,
}
normalized = skill_upload.normalize_schedule_plan_payload(payload)
assert normalized["minSameAccountIntervalMinutes"] == 360

with tempfile.TemporaryDirectory() as tmpdir:
    image_path = os.path.join(tmpdir, "1.png")
    with open(image_path, "wb") as f:
        f.write(b"png")

    records = [
        {
            "noteKey": "专题A/001",
            "folderPath": tmpdir,
            "images": [{"path": image_path, "name": "1.png"}],
            "publishTime": "2026-06-15 09:00",
            "xiaohongshuAccount": "账号A",
            "douyinAccount": "",
            "title": "📌四下《母鸡》讲义一页讲透省时间",
            "description": "📌统编版四年级下册《母鸡》第一课时\\n📝导入环节用作者情感变化切入梳理重点词\\n✅问题设计有梯度整体流程按情境推进\\n💡课堂直接可用备课能省不少时间",
            "tags": ["#测试"],
        },
        {
            "noteKey": "专题B/001",
            "folderPath": tmpdir,
            "images": [{"path": image_path, "name": "1.png"}],
            "publishTime": "2026-06-15 10:00",
            "xiaohongshuAccount": "账号A",
            "douyinAccount": "",
            "title": "📝七升八英语时态讲义备课少熬一晚",
            "description": "📌七升八英语动词时态讲义整理\\n📝覆盖一般现在时与一般过去时对比讲解\\n✅配套例句和课堂练习可直接展示\\n🔥衔接课备课这份能省下不少时间",
            "tags": ["#测试"],
        },
    ]
    assert skill_upload.validate_records_for_dry_run(records) is True
    assert skill_upload.validate_records_for_create(records) is True
    constraints = {"minSameAccountIntervalMinutes": 360}
    assert skill_upload.validate_records_for_dry_run(records, constraints) is False
    assert skill_upload.validate_records_for_create(records, constraints) is False

    scan_path = os.path.join(tmpdir, "scan.json")
    schedule_path = os.path.join(tmpdir, "schedule.json")
    content_path = os.path.join(tmpdir, "content.json")
    output_path = os.path.join(tmpdir, "records.json")
    note_dir_a = os.path.join(tmpdir, "note1")
    note_dir_b = os.path.join(tmpdir, "note2")
    os.makedirs(note_dir_a, exist_ok=True)
    os.makedirs(note_dir_b, exist_ok=True)

    with open(scan_path, "w", encoding="utf-8") as f:
        json.dump([{
            "topic": "专题A",
            "notes": [{
                "noteKey": "专题A/001",
                "folderPath": note_dir_a,
                "images": [{"name": "1.png", "path": image_path}],
            }],
        }, {
            "topic": "专题B",
            "notes": [{
                "noteKey": "专题B/001",
                "folderPath": note_dir_b,
                "images": [{"name": "1.png", "path": image_path}],
            }],
        }], f, ensure_ascii=False)
    with open(schedule_path, "w", encoding="utf-8") as f:
        json.dump({
            "schedule": [{
                "noteKey": "专题A/001",
                "platform": "xiaohongshu",
                "account": "账号A",
                "publishTime": "2026-06-15 09:00-10:00",
            }, {
                "noteKey": "专题B/001",
                "platform": "xiaohongshu",
                "account": "账号A",
                "publishTime": "2026-06-15 09:00-10:00",
            }],
            "minSameAccountIntervalMinutes": 360,
        }, f, ensure_ascii=False)
    with open(content_path, "w", encoding="utf-8") as f:
        json.dump({
            "专题A/001": {
                "title": "这是一个合规测试标题",
                "description": "描述",
                "tags": ["#测试"],
            },
            "专题B/001": {
                "title": "这是第二个合规测试标题",
                "description": "描述",
                "tags": ["#测试"],
            }
        }, f, ensure_ascii=False)

    with contextlib.redirect_stdout(io.StringIO()):
        skill_upload.cmd_build_records(scan_path, schedule_path, content_path, output_path, seed="unit-test")
    with open(output_path, encoding="utf-8") as f:
        output_payload = json.load(f)
    assert output_payload["constraints"]["minSameAccountIntervalMinutes"] == 360
    assert len(output_payload["records"]) == 2
    assert output_payload["records"][0]["xiaohongshuAccount"] == "账号A"
    assert skill_upload.validate_records_for_dry_run(
        output_payload["records"],
        output_payload["constraints"],
    ) is False
`;

  const result = spawnSync('python3', ['-c', pythonCheck], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
