const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const tempRoot = path.join(os.tmpdir(), 'zhifa-scheduler-test');
process.env.NOTE_PUBLISHER_CONFIG_DIR = path.join(tempRoot, 'config');
process.env.NOTE_PUBLISHER_DATA_DIR = path.join(tempRoot, 'data');

const Scheduler = require('../src/scheduler.js');
const publisher = require('../src/publisher.js');

function createScheduler() {
  const scheduler = new Scheduler({
    feishu: { appId: 'app', appSecret: 'secret', appToken: 'token', tableId: 'table' },
    yixiaoer: {},
    accountMapping: { xiaohongshu: {}, douyin: {} },
    yixiaoerAccountCache: { xiaohongshu: {}, douyin: {} },
    schedule: { periods: [] },
    rules: { publishRecordConcurrency: 1 },
  });

  scheduler.log = () => {};
  scheduler.setProgress = () => {};
  scheduler.recordHasPendingPlatform = () => true;
  scheduler.requiresYixiaoerLogin = () => false;
  scheduler.syncAccountMappingsForRecords = async () => {};

  return scheduler;
}

test('publishRecords queues records that arrive while a batch is already running', async () => {
  const scheduler = createScheduler();
  const processed = [];
  let queuedResult = null;

  scheduler.processSingleRecord = async (record) => {
    processed.push(record.recordId);

    if (record.recordId === 'record-a') {
      queuedResult = await scheduler.publishRecords([{ recordId: 'record-c', title: 'C' }], 'scheduled');
    }

    await new Promise(resolve => setTimeout(resolve, 10));
    return { published: 1, failed: 0 };
  };

  const result = await scheduler.publishRecords([
    { recordId: 'record-a', title: 'A' },
    { recordId: 'record-b', title: 'B' },
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
      await scheduler.publishRecords([{ recordId: 'record-a', title: 'A duplicate' }], 'scheduled');
    }

    await new Promise(resolve => setTimeout(resolve, 10));
    return { published: 1, failed: 0 };
  };

  const result = await scheduler.publishRecords([
    { recordId: 'record-a', title: 'A' },
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
    xiaohongshuAccount: '沐沐老师',
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
      account: '沐沐老师',
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

test('publishSpecificRecord should forward manual republish intent to publisher', async () => {
  const scheduler = createScheduler();
  const originalPublishRecord = publisher.publishRecord;
  const originalGetPublishRecords = publisher.getPublishRecords;
  const originalEnsureLogin = publisher.ensureLogin;

  let receivedOptions = null;

  scheduler.feishu = {
    getUnpublishedRecords: async () => [{
      recordId: 'record-retry',
      title: 'Retry now',
      attachments: [],
      videoCover: [],
      contentType: '图文',
      note: '',
      xiaohongshuAccount: '沐沐老师',
      xiaohongshuStatus: '待发布',
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

  publisher.publishRecord = async (_record, _config, _mapping, options) => {
    receivedOptions = options;
    return [{
      success: true,
      finalized: true,
      skipped: false,
      platform: '小红书',
      account: '沐沐老师',
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
    await scheduler.publishSpecificRecord('record-retry');
    assert.equal(receivedOptions?.allowPendingRepublish, true);
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
    xiaohongshuAccount: '沐沐老师',
    xiaohongshuStatus: '待发布',
    douyinAccount: '',
    douyinStatus: '',
  };

  publisher.publishRecord = async () => [{
    success: true,
    finalized: false,
    skipped: false,
    platform: '小红书',
    account: '沐沐老师',
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
    { recordId: 'record-a', title: 'A' },
    { recordId: 'record-b', title: 'B' },
  ], 'scheduled');

  assert.deepEqual(processed, ['record-a']);
  assert.deepEqual(result, {
    published: 1,
    failed: 0,
  });
});
