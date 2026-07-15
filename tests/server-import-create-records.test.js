const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const tempRoot = path.join(os.tmpdir(), 'zhifa-server-import-test');
fs.rmSync(tempRoot, { recursive: true, force: true });
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

describe('server import integration', { concurrency: false }, () => {
after(async () => {
  await stopServer();
});
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

  const topicIndexPath = path.join(tempRoot, 'data', 'topic-index.json');
  const indexedCreateResponse = await requestJson({
    method: 'POST',
    urlPath: '/api/import/create-records',
    body: {
      records: [{
        noteKey: '教务资料/期末家长会/001',
        topic: '教务资料',
        contentGroup: '教务资料',
        accountGroup: '教师店',
        pptTopic: '期末家长会',
        title: '期末家长会资料',
        images: [],
        xiaohongshuAccount: '小红书账号A',
      }],
    },
  });
  assert.equal(indexedCreateResponse.body.results[0].status, 'success');
  const indexed = JSON.parse(fs.readFileSync(topicIndexPath, 'utf8')).records.rec_1;
  assert.equal(indexed.topicKey, '教务资料/期末家长会');
  assert.equal(indexed.displayTopic, '期末家长会');
  assert.equal(indexed.noteKey, '教务资料/期末家长会/001');
  assert.equal(indexed.source, 'import');
  assert.ok(Number.isFinite(indexed.createdAt));

  fs.rmSync(topicIndexPath, { force: true });
  const dryRunResponse = await requestJson({
    method: 'POST',
    urlPath: '/api/import/create-records',
    body: {
      dryRun: true,
      records: [{
        noteKey: '教务资料/期末家长会/preview',
        topic: '教务资料',
        pptTopic: '期末家长会',
        title: '期末家长会预览',
        images: [],
        xiaohongshuAccount: '小红书账号A',
      }],
    },
  });
  assert.equal(dryRunResponse.body.results[0].status, 'preview');
  assert.equal(fs.existsSync(topicIndexPath), false);

  fs.mkdirSync(path.dirname(topicIndexPath), { recursive: true });
  fs.writeFileSync(`${topicIndexPath}.lock`, '{}', 'utf8');
  const callsBeforeLockedBatch = createRecordCalls;
  const lockedIndexResponse = await requestJson({
    method: 'POST',
    urlPath: '/api/import/create-records',
    body: {
      records: [
        { noteKey: '锁测试/001', topic: '锁测试', title: '锁测试一', images: [], xiaohongshuAccount: '小红书账号A' },
        { noteKey: '锁测试/002', topic: '锁测试', title: '锁测试二', images: [], xiaohongshuAccount: '小红书账号A' },
      ],
    },
  });
  assert.equal(lockedIndexResponse.body.results[0].status, 'failed');
  assert.equal(lockedIndexResponse.body.results[0].reason, 'topic_index_write_failed');
  assert.equal(lockedIndexResponse.body.results[0].recordId, 'rec_1');
  assert.equal(createRecordCalls, callsBeforeLockedBatch + 1);
  fs.rmSync(`${topicIndexPath}.lock`, { force: true });
});

test('topic spacing endpoints use indexed server context and fresh confirmation', { concurrency: false }, async (t) => {
  config.feishu = { appId: 'app', appSecret: 'secret', appToken: 'token', tableId: 'table' };
  const dataDir = path.join(tempRoot, 'data');
  const topicIndexPath = path.join(dataDir, 'topic-index.json');
  const historyPath = path.join(dataDir, 'publish-history.json');
  fs.mkdirSync(dataDir, { recursive: true });

  let rawRecords = [];
  const originalGetRecords = FeishuClient.prototype.getRecords;
  FeishuClient.prototype.getRecords = async () => rawRecords;
  await startServer({ port: 3211, host: '127.0.0.1', silent: true });
  t.after(async () => {
    FeishuClient.prototype.getRecords = originalGetRecords;
    fs.rmSync(topicIndexPath, { force: true });
    fs.rmSync(historyPath, { force: true });
  });

  fs.writeFileSync(topicIndexPath, JSON.stringify({
    version: 1,
    records: {
      rec_pending: {
        topicKey: '教务资料/定语从句',
        displayTopic: '定语从句',
        noteKey: '教务资料/定语从句/旧篇',
        createdAt: 1,
        source: 'import',
      },
    },
  }), 'utf8');
  fs.writeFileSync(historyPath, '{}', 'utf8');
  rawRecords = [
    {
      record_id: 'rec_old',
      fields: {
        标题: '旧记录',
        小红书账号: ['错误多选不应解析'],
        小红书发布状态: '待发布',
        发布时间: Date.parse('2026-07-16 09:00'),
      },
    },
    {
      record_id: 'rec_pending',
      fields: {
        标题: '索引内记录',
        小红书账号: '可乐',
        小红书发布状态: '待发布',
        发布时间: Date.parse('2026-07-16 09:00'),
      },
    },
  ];

  const payload = {
    seed: 'batch-20260715',
    noteFolders: [{ topic: '教务资料', pptTopic: '定语从句', templates: ['001'] }],
    accounts: { xiaohongshu_regular: ['拉面卷卷'], xiaohongshu_special: [], douyin: [] },
    accountGroups: { 拉面卷卷: '教师店', 可乐: '教师店' },
    timeSlots: { regular: ['2026-07-16 16:00'], special: [] },
    coverageStrategy: 'minimum',
  };
  const checkResponse = await requestJson({ method: 'POST', urlPath: '/api/import/topic-spacing-check', body: payload });
  assert.equal(checkResponse.statusCode, 200);
  assert.equal(checkResponse.body.requiresConfirmation, true);
  assert.equal(checkResponse.body.conflicts.length, 1);
  assert.equal(checkResponse.body.reservationCount, 1);
  assert.match(checkResponse.body.inputFingerprint, /^[a-f0-9]{64}$/);

  const missingConfirmation = await requestJson({ method: 'POST', urlPath: '/api/import/schedule', body: payload });
  assert.equal(missingConfirmation.statusCode, 409);
  assert.equal(missingConfirmation.body.code, 'topic_confirmation_required');

  const confirmation = {
    inputFingerprint: checkResponse.body.inputFingerprint,
    decision: 'allow_conflicts',
    conflictIds: checkResponse.body.conflicts.map(item => item.id),
  };
  const allowed = await requestJson({
    method: 'POST',
    urlPath: '/api/import/schedule',
    body: { ...payload, existingReservations: [], confirmation },
  });
  assert.equal(allowed.statusCode, 200, JSON.stringify(allowed.body));
  assert.equal(allowed.body.schedule.length, 1);

  const stale = await requestJson({
    method: 'POST',
    urlPath: '/api/import/schedule',
    body: { ...payload, seed: 'changed-seed', confirmation },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.body.code, 'topic_confirmation_required');

  rawRecords = [{
    record_id: 'rec_pending',
    fields: {
      标题: '同账号索引内记录',
      小红书账号: '拉面卷卷',
      小红书发布状态: '待发布',
      发布时间: Date.parse('2026-07-16 09:00'),
    },
  }];
  const spacingFailure = await requestJson({
    method: 'POST',
    urlPath: '/api/import/schedule',
    body: { ...payload, timeSlots: { regular: ['2026-07-16 15:00'], special: [] }, existingReservations: [] },
  });
  assert.equal(spacingFailure.statusCode, 400);
  assert.match(spacingFailure.body.error, /361/);

  fs.writeFileSync(topicIndexPath, JSON.stringify({ version: 1, records: {} }), 'utf8');
  rawRecords = [];
  const multiCandidatePayload = {
    ...payload,
    accounts: { xiaohongshu_regular: ['拉面卷卷', '可乐'], xiaohongshu_special: [], douyin: [] },
  };
  const oneNoteNoExisting = await requestJson({
    method: 'POST',
    urlPath: '/api/import/topic-spacing-check',
    body: multiCandidatePayload,
  });
  assert.equal(oneNoteNoExisting.statusCode, 200);
  assert.equal(oneNoteNoExisting.body.requiresConfirmation, false);

  const twoNotesSameTopic = await requestJson({
    method: 'POST',
    urlPath: '/api/import/topic-spacing-check',
    body: {
      ...multiCandidatePayload,
      noteFolders: [{ topic: '教务资料', pptTopic: '定语从句', templates: ['001', '002'] }],
    },
  });
  assert.equal(twoNotesSameTopic.statusCode, 200);
  assert.equal(twoNotesSameTopic.body.requiresConfirmation, true);

  fs.writeFileSync(topicIndexPath, '{broken', 'utf8');
  const brokenIndex = await requestJson({ method: 'POST', urlPath: '/api/import/topic-spacing-check', body: payload });
  assert.equal(brokenIndex.statusCode, 500);
  assert.match(brokenIndex.body.error, /主题索引|JSON/);

  fs.writeFileSync(topicIndexPath, JSON.stringify({ version: 1, records: {} }), 'utf8');
  fs.writeFileSync(historyPath, '{broken', 'utf8');
  const brokenHistory = await requestJson({ method: 'POST', urlPath: '/api/import/topic-spacing-check', body: payload });
  assert.equal(brokenHistory.statusCode, 500);
  assert.match(brokenHistory.body.error, /发布历史|JSON/);
});
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
