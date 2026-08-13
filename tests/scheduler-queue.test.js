const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zhifa-scheduler-test-'));
process.env.NOTE_PUBLISHER_CONFIG_DIR = path.join(tempRoot, 'config');
process.env.NOTE_PUBLISHER_DATA_DIR = path.join(tempRoot, 'data');
fs.mkdirSync(process.env.NOTE_PUBLISHER_DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.NOTE_PUBLISHER_DATA_DIR, 'publish-ledger.json'), '{}\n');
fs.writeFileSync(path.join(process.env.NOTE_PUBLISHER_DATA_DIR, 'publish-history.json'), '{}\n');

const accountsPath = path.join(process.env.NOTE_PUBLISHER_CONFIG_DIR, 'accounts.json');
const testXhsAccounts = ['晓晓老师', '最近发布防重测试账号', '沐沐老师', '云发布测试账号', '云提交频控账号', '六小时测试账号', '浅浅'];
function writeAccounts(value = { xiaohongshu: { default: testXhsAccounts } }) {
  fs.mkdirSync(process.env.NOTE_PUBLISHER_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(accountsPath, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
}
writeAccounts();

const Scheduler = require('../src/scheduler.js');
const publisher = require('../src/publisher.js');

function createScheduler() {
  const scheduler = new Scheduler({
    feishu: { appId: 'app', appSecret: 'secret', appToken: 'token', tableId: 'table' },
    yixiaoer: {},
    accountMapping: { xiaohongshu: {}, douyin: {} },
    yixiaoerAccountCache: { xiaohongshu: {}, douyin: {} },
    schedule: { periods: [] },
    rules: {
      publishRecordConcurrency: 1,
    },
  });

  scheduler.log = () => {};
  scheduler.setProgress = () => {};
  scheduler.recordHasPendingPlatform = () => true;
  scheduler.requiresYixiaoerLogin = () => false;
  scheduler.syncAccountMappingsForRecords = async () => {};

  return scheduler;
}

test('accounts.json.xiaohongshu.default 是唯一授权源，抖音恒定拒绝', () => {
  const scheduler = createScheduler();
  writeAccounts({ xiaohongshu: { default: ['  甲老师  ', '乙老师'] }, douyin: { default: ['抖音账号'] } });
  assert.equal(scheduler.isAutoPublishAllowed('xiaohongshu', '甲老师'), true);
  assert.equal(scheduler.isAutoPublishAllowed('xiaohongshu', '乙老师'), true);
  assert.equal(scheduler.isAutoPublishAllowed('xiaohongshu', '非名单小红书'), false);
  assert.equal(scheduler.isAutoPublishAllowed('douyin', '抖音账号'), false);
  writeAccounts();
});

test('accounts.json 缺失、坏 JSON、畸形字段、空数组、非字符串、空白与 trim 重复全部 fail-closed', () => {
  const scheduler = createScheduler();
  const invalidInputs = [
    null,
    '{bad json',
    {},
    { xiaohongshu: {} },
    { xiaohongshu: { default: [] } },
    { xiaohongshu: { default: ['甲老师', 1] } },
    { xiaohongshu: { default: ['甲老师', '  '] } },
    { xiaohongshu: { default: ['甲老师', ' 甲老师 '] } },
  ];
  for (const input of invalidInputs) {
    if (input === null) fs.renameSync(accountsPath, `${accountsPath}.missing`);
    else writeAccounts(input);
    assert.equal(scheduler.isAutoPublishAllowed('xiaohongshu', '甲老师'), false);
    if (input === null) fs.renameSync(`${accountsPath}.missing`, accountsPath);
  }
  writeAccounts();
});

test('accounts.json 更新后下一次入口立即采用新名单', () => {
  const scheduler = createScheduler();
  writeAccounts({ xiaohongshu: { default: ['甲老师'] } });
  assert.equal(scheduler.isAutoPublishAllowed('xiaohongshu', '甲老师'), true);
  writeAccounts({ xiaohongshu: { default: ['乙老师'] } });
  assert.equal(scheduler.isAutoPublishAllowed('xiaohongshu', '甲老师'), false);
  assert.equal(scheduler.isAutoPublishAllowed('xiaohongshu', '乙老师'), true);
  writeAccounts();
});

test('白名单在扫描、定时器重读、立即补发和单条立即发布入口前拦截，名单内小红书可进入三类入口', async () => {
  const scheduler = createScheduler();
  scheduler.recordHasPendingPlatform = Scheduler.prototype.recordHasPendingPlatform.bind(scheduler);
  const now = Date.now();
  const allowed = {
    recordId: 'allowed', title: '允许发布', attachments: ['a'], publishTime: new Date(now - 1000),
    xiaohongshuAccount: '晓晓老师', xiaohongshuStatus: '待发布', douyinAccount: '', douyinStatus: '',
  };
  const blockedXhs = { ...allowed, recordId: 'blocked-xhs', xiaohongshuAccount: '非名单小红书' };
  const blockedDy = {
    ...allowed, recordId: 'blocked-dy', xiaohongshuAccount: '', xiaohongshuStatus: '',
    douyinAccount: '任意抖音账号', douyinStatus: '待发布',
  };
  const publishedBatches = [];
  scheduler.publishRecords = async (records) => {
    publishedBatches.push(records.map(record => record.recordId));
    return { published: records.length, failed: 0 };
  };
  scheduler.feishu = {
    hasPendingRecords: async () => true,
    getPendingRecords: async () => [allowed, blockedXhs, blockedDy],
    getUnpublishedRecords: async () => [allowed, blockedXhs, blockedDy],
    parseRecord: record => record,
  };
  scheduler.running = true;

  await scheduler.checkAndPublish();
  assert.deepEqual(publishedBatches, [['allowed']]);
  publishedBatches.length = 0;
  await scheduler.manualPublishNow();
  assert.deepEqual(publishedBatches, [['allowed']]);
  publishedBatches.length = 0;
  await scheduler.publishSpecificRecord('allowed');
  await assert.rejects(scheduler.publishSpecificRecord('blocked-xhs'), /没有获准/);
  await assert.rejects(scheduler.publishSpecificRecord('blocked-dy'), /没有获准/);
  assert.deepEqual(publishedBatches, [['allowed']]);
  publishedBatches.length = 0;

  let timerCallback;
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = callback => {
    timerCallback = callback;
    return 1;
  };
  try {
    scheduler.loadCurrentPendingRecord = async () => blockedXhs;
    scheduler.scheduleRecordTask(allowed, new Date(now));
    timerCallback();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(publishedBatches, []);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test('processSingleRecord 在下载、发布器、飞书状态和账本之前拒绝非名单账号', async () => {
  const scheduler = createScheduler();
  const blocked = {
    recordId: 'blocked-before-side-effects',
    title: '不应发布',
    attachments: ['a'],
    xiaohongshuAccount: '非名单小红书',
    xiaohongshuStatus: '待发布',
    douyinAccount: '',
    douyinStatus: '',
  };
  const calls = { download: 0, status: 0, note: 0, published: 0, publisher: 0 };
  scheduler.feishu = {
    downloadAllAttachments: async () => { calls.download++; },
    markPlatformStatus: async () => { calls.status++; },
    setNote: async () => { calls.note++; },
    markPublished: async () => { calls.published++; },
  };
  const originalPublishRecord = publisher.publishRecord;
  publisher.publishRecord = async () => { calls.publisher++; };
  try {
    assert.deepEqual(await scheduler.processSingleRecord(blocked), { published: 0, failed: 0 });
    assert.deepEqual(calls, { download: 0, status: 0, note: 0, published: 0, publisher: 0 });
  } finally {
    publisher.publishRecord = originalPublishRecord;
  }
});

test('processSingleRecord 下载期间撤销全部授权时不调用发布器或写入事实状态', async () => {
  const scheduler = createScheduler();
  const calls = { publisher: 0, status: 0, note: 0, published: 0, history: 0, ledger: 0 };
  scheduler.feishu = {
    downloadAllAttachments: async () => {
      writeAccounts({ xiaohongshu: { default: [] } });
      return ['downloaded.png'];
    },
    markPlatformStatus: async () => { calls.status += 1; },
    setNote: async () => { calls.note += 1; },
    markPublished: async () => { calls.published += 1; },
  };
  const originalPublishRecord = publisher.publishRecord;
  const originalAppendHistory = publisher.appendHistory;
  const originalMarkAsPublished = publisher.markAsPublished;
  publisher.publishRecord = async () => { calls.publisher += 1; return []; };
  publisher.appendHistory = () => { calls.history += 1; };
  publisher.markAsPublished = () => { calls.ledger += 1; };
  try {
    const result = await scheduler.processSingleRecord({
      recordId: 'revoked-during-download', title: '下载后撤权', attachments: ['a'], videoCover: [], contentType: '图文', note: '',
      xiaohongshuAccount: '晓晓老师', xiaohongshuStatus: '待发布', douyinAccount: '', douyinStatus: '',
    });
    assert.deepEqual(result, { published: 0, failed: 0 });
    assert.deepEqual(calls, { publisher: 0, status: 0, note: 0, published: 0, history: 0, ledger: 0 });
  } finally {
    publisher.publishRecord = originalPublishRecord;
    publisher.appendHistory = originalAppendHistory;
    publisher.markAsPublished = originalMarkAsPublished;
    writeAccounts();
  }
});

test('processSingleRecord 下载后再次过滤混合记录，仅向发布器传递仍获授权的小红书', async () => {
  const scheduler = createScheduler();
  let publishedRecord = null;
  scheduler.feishu = {
    downloadAllAttachments: async () => {
      writeAccounts({ xiaohongshu: { default: ['晓晓老师'] } });
      return ['downloaded.png'];
    },
    markPlatformStatus: async () => {},
    setNote: async () => {},
    markPublished: async () => {},
  };
  const originalPublishRecord = publisher.publishRecord;
  publisher.publishRecord = async record => {
    publishedRecord = record;
    return [{ success: true, finalized: true, skipped: true, platform: '小红书', account: '晓晓老师' }];
  };
  try {
    await scheduler.processSingleRecord({
      recordId: 'mixed-recheck', title: '混合下载后复核', attachments: ['a'], videoCover: [], contentType: '图文', note: '',
      xiaohongshuAccount: '晓晓老师', xiaohongshuStatus: '待发布', douyinAccount: '抖音账号', douyinStatus: '待发布',
    });
    assert.equal(publishedRecord.xiaohongshuAccount, '晓晓老师');
    assert.equal(publishedRecord.xiaohongshuStatus, '待发布');
    assert.equal(publishedRecord.douyinAccount, '');
    assert.equal(publishedRecord.douyinStatus, '');
  } finally {
    publisher.publishRecord = originalPublishRecord;
    writeAccounts();
  }
});

test('无待发布平台的记录不入队，也不触发下载、发布器、飞书状态或账本写入', async () => {
  const scheduler = createScheduler();
  const calls = { process: 0, download: 0, status: 0, publisher: 0 };
  scheduler.processSingleRecord = async () => { calls.process += 1; };
  scheduler.feishu = {
    downloadAllAttachments: async () => { calls.download += 1; },
    markPlatformStatus: async () => { calls.status += 1; },
  };
  const originalPublishRecord = publisher.publishRecord;
  publisher.publishRecord = async () => { calls.publisher += 1; };
  try {
    const result = await scheduler.publishRecords([{
      recordId: 'no-pending-platform', title: 'No pending platform', attachments: ['a'],
      xiaohongshuAccount: '晓晓老师', xiaohongshuStatus: '已发布',
      douyinAccount: '被拒抖音账号', douyinStatus: '发布失败',
    }], 'scheduled');
    assert.deepEqual(result, { published: 0, failed: 0 });
    assert.equal(scheduler.pendingPublishRecords.size, 0);
    assert.deepEqual(calls, { process: 0, download: 0, status: 0, publisher: 0 });
  } finally {
    publisher.publishRecord = originalPublishRecord;
  }
});

test('混合记录入队前清空被拒抖音字段，登录和账号映射只收到允许小红书', async () => {
  const scheduler = createScheduler();
  const seen = { login: null, mapping: null, processed: null };
  scheduler.requiresYixiaoerLogin = records => {
    seen.login = records;
    return true;
  };
  scheduler.syncAccountMappingsForRecords = async records => { seen.mapping = records; };
  scheduler.processSingleRecord = async record => {
    seen.processed = record;
    return { published: 1, failed: 0 };
  };
  const originalEnsureLogin = publisher.ensureLogin;
  publisher.ensureLogin = async () => {};
  try {
    const result = await scheduler.publishRecords([{
      recordId: 'mixed-queue-record', title: 'Mixed queue record', attachments: ['a'],
      xiaohongshuAccount: '晓晓老师', xiaohongshuStatus: '待发布',
      douyinAccount: '被拒抖音账号', douyinStatus: '待发布',
    }], 'scheduled');
    assert.deepEqual(result, { published: 1, failed: 0 });
    for (const records of [seen.login, seen.mapping]) {
      assert.equal(records.length, 1);
      assert.equal(records[0].xiaohongshuAccount, '晓晓老师');
      assert.equal(records[0].xiaohongshuStatus, '待发布');
      assert.equal(records[0].douyinAccount, '');
      assert.equal(records[0].douyinStatus, '');
    }
    assert.equal(seen.processed.douyinAccount, '');
    assert.equal(seen.processed.douyinStatus, '');
  } finally {
    publisher.ensureLogin = originalEnsureLogin;
  }
});

test('小红书和抖音均不在名单的记录会被清空并拒绝入队', () => {
  const scheduler = createScheduler();
  const queued = scheduler.enqueuePublishRecords([{
    recordId: 'fully-blocked-queue-record', title: 'Fully blocked', attachments: ['a'],
    xiaohongshuAccount: '非名单小红书', xiaohongshuStatus: '待发布',
    douyinAccount: '被拒抖音账号', douyinStatus: '待发布',
  }]);
  assert.equal(queued, 0);
  assert.equal(scheduler.pendingPublishRecords.size, 0);
});

test('publishRecords queues records that arrive while a batch is already running', async () => {
  const scheduler = createScheduler();
  const processed = [];
  let queuedResult = null;

  scheduler.processSingleRecord = async (record) => {
    processed.push(record.recordId);

    if (record.recordId === 'record-a') {
      queuedResult = await scheduler.publishRecords([{ recordId: 'record-c', title: 'C', xiaohongshuAccount: '晓晓老师', xiaohongshuStatus: '待发布' }], 'scheduled');
    }

    await new Promise(resolve => setTimeout(resolve, 10));
    return { published: 1, failed: 0 };
  };

  const result = await scheduler.publishRecords([
    { recordId: 'record-a', title: 'A', xiaohongshuAccount: '晓晓老师', xiaohongshuStatus: '待发布' },
    { recordId: 'record-b', title: 'B', xiaohongshuAccount: '晓晓老师', xiaohongshuStatus: '待发布' },
  ], 'manual');

  assert.deepEqual(processed, ['record-a', 'record-b', 'record-c']);
  assert.deepEqual(queuedResult, {
    published: 0,
    failed: 0,
    queued: 1,
    inProgress: true,
  });
  assert.deepEqual(result, {
    published: 3,
    failed: 0,
  });
});

test('publishRecords does not enqueue a record that is already in flight', async () => {
  const scheduler = createScheduler();
  const processed = [];

  scheduler.processSingleRecord = async (record) => {
    processed.push(record.recordId);

    if (record.recordId === 'record-a') {
      await scheduler.publishRecords([{ recordId: 'record-a', title: 'A duplicate', xiaohongshuAccount: '晓晓老师', xiaohongshuStatus: '待发布' }], 'scheduled');
    }

    await new Promise(resolve => setTimeout(resolve, 10));
    return { published: 1, failed: 0 };
  };

  const result = await scheduler.publishRecords([
    { recordId: 'record-a', title: 'A', xiaohongshuAccount: '晓晓老师', xiaohongshuStatus: '待发布' },
  ], 'manual');

  assert.deepEqual(processed, ['record-a']);
  assert.deepEqual(result, {
    published: 1,
    failed: 0,
  });
});

test('publishRecords should not reprocess a record immediately after a successful publish', async () => {
  const scheduler = createScheduler();
  const originalPublishRecord = publisher.publishRecord;
  const originalGetPublishRecords = publisher.getPublishRecords;
  const originalEnsureLogin = publisher.ensureLogin;

  let publishCalls = 0;

  scheduler.feishu = {
    downloadAllAttachments: async () => [],
    markPlatformStatus: async () => {},
    setNote: async () => {},
    markPublished: async () => {},
  };
  scheduler.log = () => {};
  scheduler.setProgress = () => {};
  scheduler.findLatestPublishRecord = async () => null;

  const record = {
    recordId: 'record-stale',
    title: 'Stale snapshot',
    attachments: [],
    videoCover: [],
    contentType: '图文',
    note: '',
    xiaohongshuAccount: '最近发布防重测试账号',
    xiaohongshuStatus: '待发布',
    douyinAccount: '',
    douyinStatus: '',
  };

  publisher.publishRecord = async () => {
    publishCalls += 1;
    return [{
      success: true,
      skipped: false,
      platform: '小红书',
      account: '最近发布防重测试账号',
      accountId: 'xhs-1',
      publishMode: '云发布',
      taskMeta: null,
      titleMeta: null,
      musicMeta: null,
    }];
  };
  publisher.getPublishRecords = async () => [];
  publisher.ensureLogin = async () => {};

  try {
    await scheduler.publishRecords([{ ...record }], 'scheduled');
    await scheduler.publishRecords([{ ...record }], 'scheduled');

    assert.equal(publishCalls, 1);
  } finally {
    publisher.publishRecord = originalPublishRecord;
    publisher.getPublishRecords = originalGetPublishRecords;
    publisher.ensureLogin = originalEnsureLogin;
  }
});

test('manualPublishNow should only publish records whose platform status is exactly 待发布', async () => {
  const scheduler = createScheduler();
  const processed = [];

  scheduler.recordHasPendingPlatform = Scheduler.prototype.recordHasPendingPlatform.bind(scheduler);
  scheduler.feishu = {
    getUnpublishedRecords: async () => ([
      {
        recordId: 'record-failed',
        title: 'Failed only',
        attachments: [],
        videoCover: [],
        contentType: '图文',
        note: '',
        publishTime: new Date(Date.now() - 60 * 1000),
        xiaohongshuAccount: '沐沐老师',
        xiaohongshuStatus: '发布失败',
        douyinAccount: '',
        douyinStatus: '',
      },
      {
        recordId: 'record-pending',
        title: 'Pending only',
        attachments: [],
        videoCover: [],
        contentType: '图文',
        note: '',
        publishTime: new Date(Date.now() - 60 * 1000),
        xiaohongshuAccount: '沐沐老师',
        xiaohongshuStatus: '待发布',
        douyinAccount: '',
        douyinStatus: '',
      },
    ]),
    parseRecord: record => record,
  };
  scheduler.processSingleRecord = async (record) => {
    processed.push(record.recordId);
    return { published: 1, failed: 0 };
  };

  const result = await scheduler.manualPublishNow();

  assert.deepEqual(processed, ['record-pending']);
  assert.deepEqual(result, {
    published: 1,
    failed: 0,
  });
});

test('publishSpecificRecord should reject a record whose platforms are not 待发布', async () => {
  const scheduler = createScheduler();
  const originalPublishRecord = publisher.publishRecord;
  const originalGetPublishRecords = publisher.getPublishRecords;
  const originalEnsureLogin = publisher.ensureLogin;

  scheduler.recordHasPendingPlatform = Scheduler.prototype.recordHasPendingPlatform.bind(scheduler);
  scheduler.feishu = {
    getUnpublishedRecords: async () => [{
      recordId: 'record-retry',
      title: 'Retry now',
      attachments: [],
      videoCover: [],
      contentType: '图文',
      note: '',
      xiaohongshuAccount: '沐沐老师',
      xiaohongshuStatus: '发布失败',
      douyinAccount: '',
      douyinStatus: '',
    }],
    parseRecord: (record) => record,
    downloadAllAttachments: async () => [],
    markPlatformStatus: async () => {},
    setNote: async () => {},
    markPublished: async () => {},
  };
  scheduler.findLatestPublishRecord = async () => null;

  let publishCalled = false;
  publisher.publishRecord = async () => {
    publishCalled = true;
    return [];
  };
  publisher.getPublishRecords = async () => [];
  publisher.ensureLogin = async () => {};

  try {
    await assert.rejects(
      scheduler.publishSpecificRecord('record-retry'),
      /该记录没有获准由知发发布的平台/
    );
    assert.equal(publishCalled, false);
  } finally {
    publisher.publishRecord = originalPublishRecord;
    publisher.getPublishRecords = originalGetPublishRecords;
    publisher.ensureLogin = originalEnsureLogin;
  }
});

test('processSingleRecord should keep cloud submissions in processing status until final result is known', async () => {
  const scheduler = createScheduler();
  const originalPublishRecord = publisher.publishRecord;
  const originalGetPublishRecords = publisher.getPublishRecords;
  const originalEnsureLogin = publisher.ensureLogin;

  const platformUpdates = [];
  let recordMarkedPublished = false;

  scheduler.feishu = {
    downloadAllAttachments: async () => [],
    markPlatformStatus: async (recordId, platform, status) => {
      platformUpdates.push({ recordId, platform, status });
    },
    setNote: async () => {},
    markPublished: async () => {
      recordMarkedPublished = true;
    },
  };
  scheduler.findLatestPublishRecord = async () => null;

  const record = {
    recordId: 'record-cloud',
    title: 'Cloud submit',
    attachments: [],
    videoCover: [],
    contentType: '图文',
    note: '',
    xiaohongshuAccount: '云发布测试账号',
    xiaohongshuStatus: '待发布',
    douyinAccount: '',
    douyinStatus: '',
  };

  publisher.publishRecord = async () => [{
    success: true,
    finalized: false,
    skipped: false,
    platform: '小红书',
    account: '云发布测试账号',
    accountId: 'xhs-1',
    publishMode: '云发布',
    taskMeta: { taskId: 'task-1' },
    titleMeta: null,
    musicMeta: null,
  }];
  publisher.getPublishRecords = async () => [];
  publisher.ensureLogin = async () => {};

  try {
    const result = await scheduler.processSingleRecord(record);

    assert.deepEqual(platformUpdates, [{
      recordId: 'record-cloud',
      platform: '小红书',
      status: '发布中',
    }]);
    assert.equal(recordMarkedPublished, false);
    assert.deepEqual(result, {
      published: 0,
      failed: 0,
      submitted: 1,
    });
  } finally {
    publisher.publishRecord = originalPublishRecord;
    publisher.getPublishRecords = originalGetPublishRecords;
    publisher.ensureLogin = originalEnsureLogin;
  }
});

test('processSingleRecord does not defer same platform account publish when history is within 6 hours', async () => {
  const scheduler = createScheduler();
  const originalPublishRecord = publisher.publishRecord;
  const originalGetPublishRecords = publisher.getPublishRecords;
  const originalEnsureLogin = publisher.ensureLogin;

  let publishCalls = 0;
  const platformUpdates = [];
  let recordMarkedPublished = false;

  scheduler.feishu = {
    downloadAllAttachments: async () => [],
    markPlatformStatus: async (recordId, platform, status) => {
      platformUpdates.push({ recordId, platform, status });
    },
    setNote: async () => {},
    markPublished: async () => {
      recordMarkedPublished = true;
    },
  };
  scheduler.findLatestPublishRecord = async () => null;

  publisher.appendHistory('already-published-record', '小红书', {
    accountName: '六小时测试账号',
    accountId: 'xhs-guard',
    channel: '蚁小二',
    at: Date.now() - 30 * 60 * 1000,
    taskId: 'task-guard',
    contentHash: 'hash-guard',
  });
  publisher.publishRecord = async () => {
    publishCalls += 1;
    return [{
      success: true,
      finalized: true,
      skipped: false,
      platform: '小红书',
      account: '六小时测试账号',
      accountId: 'xhs-guard',
      publishMode: '蚁小二',
      taskMeta: null,
      titleMeta: null,
      musicMeta: null,
    }];
  };
  publisher.getPublishRecords = async () => [];
  publisher.ensureLogin = async () => {};

  const record = {
    recordId: 'record-too-soon',
    title: 'Too soon',
    attachments: [],
    videoCover: [],
    contentType: '图文',
    note: '',
    xiaohongshuAccount: '六小时测试账号',
    xiaohongshuStatus: '待发布',
    douyinAccount: '',
    douyinStatus: '',
  };

  try {
    const result = await scheduler.processSingleRecord(record);

    assert.equal(publishCalls, 1);
    assert.deepEqual(platformUpdates, [{
      recordId: 'record-too-soon',
      platform: '小红书',
      status: '已发布',
    }]);
    assert.equal(recordMarkedPublished, true);
    assert.deepEqual(result, { published: 1, failed: 0 });
  } finally {
    publisher.publishRecord = originalPublishRecord;
    publisher.getPublishRecords = originalGetPublishRecords;
    publisher.ensureLogin = originalEnsureLogin;
  }
});

test('processSingleRecord does not defer same account after a cloud submission', async () => {
  const scheduler = createScheduler();
  const originalPublishRecord = publisher.publishRecord;
  const originalGetPublishRecords = publisher.getPublishRecords;
  const originalEnsureLogin = publisher.ensureLogin;

  let publishCalls = 0;
  const platformUpdates = [];

  scheduler.feishu = {
    downloadAllAttachments: async () => [],
    markPlatformStatus: async (recordId, platform, status) => {
      platformUpdates.push({ recordId, platform, status });
    },
    setNote: async () => {},
    markPublished: async () => {},
  };
  scheduler.findLatestPublishRecord = async () => null;
  publisher.publishRecord = async () => {
    publishCalls += 1;
    return [{
      success: true,
      finalized: false,
      skipped: false,
      platform: '小红书',
      account: '云提交频控账号',
      accountId: 'xhs-cloud-guard',
      publishMode: '云发布',
      taskMeta: { taskId: 'cloud-guard' },
      titleMeta: null,
      musicMeta: null,
    }];
  };
  publisher.getPublishRecords = async () => [];
  publisher.ensureLogin = async () => {};

  try {
    const first = await scheduler.processSingleRecord({
      recordId: 'record-cloud-guard-a',
      title: 'Cloud Guard A',
      attachments: [],
      videoCover: [],
      contentType: '图文',
      note: '',
      xiaohongshuAccount: '云提交频控账号',
      xiaohongshuStatus: '待发布',
      douyinAccount: '',
      douyinStatus: '',
    });
    const second = await scheduler.processSingleRecord({
      recordId: 'record-cloud-guard-b',
      title: 'Cloud Guard B',
      attachments: [],
      videoCover: [],
      contentType: '图文',
      note: '',
      xiaohongshuAccount: '云提交频控账号',
      xiaohongshuStatus: '待发布',
      douyinAccount: '',
      douyinStatus: '',
    });

    assert.deepEqual(first, { published: 0, failed: 0, submitted: 1 });
    assert.deepEqual(second, { published: 0, failed: 0, submitted: 1 });
    assert.equal(publishCalls, 2);
    assert.deepEqual(platformUpdates, [
      { recordId: 'record-cloud-guard-a', platform: '小红书', status: '发布中' },
      { recordId: 'record-cloud-guard-b', platform: '小红书', status: '发布中' },
    ]);
  } finally {
    publisher.publishRecord = originalPublishRecord;
    publisher.getPublishRecords = originalGetPublishRecords;
    publisher.ensureLogin = originalEnsureLogin;
  }
});

test('publishRecords preserves deferred results returned by record processing', async () => {
  const scheduler = createScheduler();
  scheduler.processSingleRecord = async () => ({ published: 0, failed: 0, deferred: 1 });

  const result = await scheduler.publishRecords([{
    recordId: 'record-deferred',
    title: 'Deferred',
    xiaohongshuAccount: '浅浅',
    xiaohongshuStatus: '待发布',
  }], 'scheduled');

  assert.deepEqual(result, {
    published: 0,
    failed: 0,
    deferred: 1,
  });
});

test('start should perform an immediate scan before waiting for the next window', async () => {
  const scheduler = createScheduler();
  let scanCalls = 0;
  let scheduleCalls = 0;

  scheduler.checkAndPublish = async () => {
    scanCalls += 1;
  };
  scheduler.scheduleNext = () => {
    scheduleCalls += 1;
  };

  scheduler.start();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(scanCalls, 1);
  assert.equal(scheduleCalls, 1);
});

test('stop should prevent queued scheduled records from starting after the current one', async () => {
  const scheduler = createScheduler();
  const processed = [];

  scheduler.processSingleRecord = async (record) => {
    processed.push(record.recordId);
    if (record.recordId === 'record-a') {
      scheduler.stop();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return { published: 1, failed: 0, submitted: 0 };
  };

  const result = await scheduler.publishRecords([
    { recordId: 'record-a', title: 'A', xiaohongshuAccount: '晓晓老师', xiaohongshuStatus: '待发布' },
    { recordId: 'record-b', title: 'B', xiaohongshuAccount: '晓晓老师', xiaohongshuStatus: '待发布' },
  ], 'scheduled');

  assert.deepEqual(processed, ['record-a']);
  assert.deepEqual(result, {
    published: 1,
    failed: 0,
  });
});
