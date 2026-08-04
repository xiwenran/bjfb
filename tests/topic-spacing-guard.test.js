const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  TOPIC_INDEX_VERSION,
  getRuntimePaths,
  readTopicIndex,
  saveTopicIndex,
  upsertTopicIndexRecord,
} = require('../src/config-store.js');

const {
  normalizeTopicKey,
  buildTopicCheckFingerprint,
  collectIndexedReservations,
  findCrossAccountTopicConflicts,
  validateTopicConfirmation,
} = require('../src/topic-spacing-guard.js');

let runtimeRoot;
let originalConfigDir;
let originalDataDir;

function useIsolatedRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhifa-topic-index-'));
  process.env.NOTE_PUBLISHER_CONFIG_DIR = path.join(root, 'config');
  process.env.NOTE_PUBLISHER_DATA_DIR = path.join(root, 'data');
  return root;
}

function validEntry(overrides = {}) {
  return {
    topicKey: '剧本杀英语/定语从句',
    displayTopic: '剧本杀英语·定语从句',
    noteKey: 'note-001',
    createdAt: 1784073600000,
    source: 'import',
    ...overrides,
  };
}

function listTopicIndexTempFiles() {
  const paths = getRuntimePaths();
  if (!fs.existsSync(paths.dataDir)) return [];
  return fs.readdirSync(paths.dataDir)
    .filter(name => name.startsWith('topic-index.json.tmp-'));
}

test.beforeEach(() => {
  originalConfigDir = process.env.NOTE_PUBLISHER_CONFIG_DIR;
  originalDataDir = process.env.NOTE_PUBLISHER_DATA_DIR;
  runtimeRoot = useIsolatedRuntime();
});

test.afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.NOTE_PUBLISHER_CONFIG_DIR;
  else process.env.NOTE_PUBLISHER_CONFIG_DIR = originalConfigDir;
  if (originalDataDir === undefined) delete process.env.NOTE_PUBLISHER_DATA_DIR;
  else process.env.NOTE_PUBLISHER_DATA_DIR = originalDataDir;
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

test('topic index runtime path is stored in the data directory', () => {
  const paths = getRuntimePaths();
  assert.equal(paths.topicIndexPath, path.join(paths.dataDir, 'topic-index.json'));
});

test('missing topic index returns an empty versioned index', () => {
  assert.deepEqual(readTopicIndex(), {
    version: TOPIC_INDEX_VERSION,
    records: {},
  });
});

test('saveTopicIndex writes the validated index atomically', () => {
  const index = {
    version: 1,
    records: { rec001: validEntry() },
  };

  const saved = saveTopicIndex(index);
  const paths = getRuntimePaths();

  assert.deepEqual(saved, index);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.topicIndexPath, 'utf-8')), index);
  assert.deepEqual(listTopicIndexTempFiles(), []);
});

test('upsertTopicIndexRecord preserves existing records and atomically adds one entry', () => {
  saveTopicIndex({
    version: 1,
    records: { rec001: validEntry() },
  });

  const added = validEntry({
    topicKey: '剧本杀英语/被动语态',
    displayTopic: '剧本杀英语·被动语态',
    noteKey: 'note-002',
    createdAt: 1784077200000,
  });
  const updated = upsertTopicIndexRecord('rec002', added);

  assert.deepEqual(updated.records, {
    rec001: validEntry(),
    rec002: added,
  });
  assert.deepEqual(readTopicIndex(), updated);
});

test('existing malformed JSON fails closed', () => {
  const paths = getRuntimePaths();
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(paths.topicIndexPath, '{broken', 'utf-8');

  assert.throws(() => readTopicIndex(), /读取 JSON 失败/);
});

test('unsupported topic index version fails closed', () => {
  const paths = getRuntimePaths();
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(paths.topicIndexPath, JSON.stringify({ version: 2, records: {} }), 'utf-8');

  assert.throws(() => readTopicIndex(), /版本/);
});

test('invalid records container fails closed', () => {
  const paths = getRuntimePaths();
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(paths.topicIndexPath, JSON.stringify({ version: 1, records: [] }), 'utf-8');

  assert.throws(() => readTopicIndex(), /records/);
});

test('invalid topic index entries fail closed', () => {
  const invalidEntries = [
    null,
    validEntry({ topicKey: '' }),
    validEntry({ displayTopic: '' }),
    validEntry({ noteKey: '' }),
    validEntry({ createdAt: Number.POSITIVE_INFINITY }),
    validEntry({ source: 'legacy' }),
  ];

  for (const entry of invalidEntries) {
    const paths = getRuntimePaths();
    fs.mkdirSync(paths.dataDir, { recursive: true });
    fs.writeFileSync(paths.topicIndexPath, JSON.stringify({
      version: 1,
      records: { rec001: entry },
    }), 'utf-8');
    assert.throws(() => readTopicIndex(), /rec001/);
  }
});

test('upsert rejects an empty record id and invalid entries before writing', () => {
  assert.throws(() => upsertTopicIndexRecord('', validEntry()), /recordId/);
  assert.throws(
    () => upsertTopicIndexRecord('rec001', validEntry({ createdAt: NaN })),
    /rec001/
  );
});

test('active topic index lock makes save and upsert fail closed without changing the old file', () => {
  const original = {
    version: 1,
    records: { rec001: validEntry() },
  };
  saveTopicIndex(original);
  const paths = getRuntimePaths();
  const lockPath = `${paths.topicIndexPath}.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), 'utf-8');

  assert.throws(
    () => saveTopicIndex({ version: 1, records: { rec002: validEntry() } }),
    /主题索引写锁已存在，请确认没有知发进程写入后人工处理/
  );
  assert.throws(
    () => upsertTopicIndexRecord('rec002', validEntry({ noteKey: 'note-002' })),
    /主题索引写锁已存在，请确认没有知发进程写入后人工处理/
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.topicIndexPath, 'utf-8')), original);
  assert.equal(fs.readFileSync(lockPath, 'utf-8'), JSON.stringify({ pid: process.pid }));
});

test('stale topic index lock also fails closed without changing the old file or lock', () => {
  const original = {
    version: 1,
    records: { rec001: validEntry() },
  };
  saveTopicIndex(original);
  const paths = getRuntimePaths();
  const lockPath = `${paths.topicIndexPath}.lock`;
  const staleLock = JSON.stringify({ pid: 2147483647 });
  fs.writeFileSync(lockPath, staleLock, 'utf-8');

  const added = validEntry({ noteKey: 'note-002' });
  assert.throws(
    () => upsertTopicIndexRecord('rec002', added),
    /主题索引写锁已存在，请确认没有知发进程写入后人工处理/
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.topicIndexPath, 'utf-8')), original);
  assert.equal(fs.readFileSync(lockPath, 'utf-8'), staleLock);
  assert.deepEqual(listTopicIndexTempFiles(), []);
});

test('topic normalization is deterministic and preserves meaning-bearing words', () => {
  assert.equal(normalizeTopicKey(' 剧本杀版英语语法／ 定语从句　'), '剧本杀版英语语法/ 定语从句');
  assert.equal(normalizeTopicKey('Ａ  \t  B'), 'A B');
  assert.notEqual(normalizeTopicKey('分数除法（一）'), normalizeTopicKey('分数除法（二）'));
  assert.notEqual(normalizeTopicKey('课程（上）'), normalizeTopicKey('课程（下）'));
  assert.notEqual(normalizeTopicKey('定语从句'), normalizeTopicKey('被动语态'));
});

test('topic check fingerprint is stable across object key order and binds only scheduling inputs', () => {
  const input = {
    noteFolders: [{ topic: '定语从句', templates: ['1'] }],
    accounts: { xiaohongshu_regular: ['可乐'] },
    accountGroups: { 可乐: '教师店' },
    timeSlots: { regular: ['2026-07-16 08:00'] },
    timeWindows: { morning: ['08:00', '12:00'] },
    perAccountPerSlot: 1,
    seed: 'batch-1',
    ignored: '不参与指纹',
  };
  const reordered = {
    ignored: '另一个无关值',
    seed: 'batch-1',
    perAccountPerSlot: 1,
    timeWindows: { morning: ['08:00', '12:00'] },
    timeSlots: { regular: ['2026-07-16 08:00'] },
    accountGroups: { 可乐: '教师店' },
    accounts: { xiaohongshu_regular: ['可乐'] },
    noteFolders: [{ templates: ['1'], topic: '定语从句' }],
  };
  const fingerprint = buildTopicCheckFingerprint(input);
  assert.equal(fingerprint, buildTopicCheckFingerprint(reordered));

  for (const [field, value] of Object.entries({
    noteFolders: [{ topic: '被动语态', templates: ['1'] }],
    accounts: { xiaohongshu_regular: ['拉面卷卷'] },
    accountGroups: { 可乐: '另一店' },
    timeSlots: { regular: ['2026-07-16 09:00'] },
    timeWindows: { morning: ['09:00', '12:00'] },
    perAccountPerSlot: 2,
    seed: 'batch-2',
  })) {
    assert.notEqual(buildTopicCheckFingerprint({ ...input, [field]: value }), fingerprint, `${field} 必须参与指纹`);
  }
});

test('only indexed records become scheduled or published reservations', () => {
  const topicIndex = {
    version: 1,
    records: {
      rec_pending: validEntry({ topicKey: '定语从句', noteKey: 'a/1' }),
      rec_processing: validEntry({ topicKey: '定语从句', noteKey: 'a/2' }),
      rec_published: validEntry({ topicKey: '定语从句', noteKey: 'a/3' }),
    },
  };
  const feishuRecords = [
    { recordId: 'rec_old', xiaohongshuAccount: '旧账号', xiaohongshuStatus: '待发布', publishTime: 1784051100000 },
    { recordId: 'rec_pending', xiaohongshuAccount: '可乐', xiaohongshuStatus: '待发布', publishTime: 1784051200000 },
    { recordId: 'rec_processing', xiaohongshuAccount: '可乐', xiaohongshuStatus: '待处理', publishTime: new Date(1784051300000) },
  ];
  const history = {
    rec_old: { 小红书: [{ accountName: '旧账号', at: 1784051400000 }] },
    rec_published: { 小红书: [{ accountName: '拉面卷卷', at: 1784051500000 }] },
  };
  const reservations = collectIndexedReservations({
    topicIndex,
    feishuRecords,
    history,
    accountGroups: { 可乐: '教师店', 拉面卷卷: '教师店' },
  });

  assert.deepEqual(reservations.map(item => [item.recordId, item.state]), [
    ['rec_pending', 'scheduled'],
    ['rec_processing', 'scheduled'],
    ['rec_published', 'published'],
  ]);
  assert.ok(reservations.every(item => item.storeGroup === '教师店'));
  assert.ok(reservations.every(item => Number.isFinite(item.publishTime)));
});

test('indexed history rejects malformed record, platform list, and list item', () => {
  const topicIndex = { version: 1, records: { rec_1: validEntry({ topicKey: '定语从句' }) } };
  const args = history => ({ topicIndex, feishuRecords: [], history, accountGroups: {} });
  for (const history of [
    { rec_1: 'broken' },
    { rec_1: { 小红书: 'broken' } },
    { rec_1: { 小红书: [null] } },
  ]) {
    assert.throws(() => collectIndexedReservations(args(history)), /发布历史.*无效/);
  }
  assert.deepEqual(collectIndexedReservations(args({})), []);
});

test('indexed reservation rejects missing store group, account, or valid time', () => {
  const index = {
    version: 1,
    records: { rec_1: validEntry({ topicKey: '定语从句' }) },
  };
  const makeArgs = record => ({
    topicIndex: index,
    feishuRecords: [record],
    history: {},
    accountGroups: { 可乐: '教师店' },
  });

  for (const [record, message] of [
    [{ recordId: 'rec_1', xiaohongshuAccount: '未知账号', xiaohongshuStatus: '待发布', publishTime: 1784051200000 }, /未配置店铺组/],
    // collectIndexedReservations 双平台化之后，账号缺失的报错文案从"缺少小红书账号"
    // 改成了平台无关的"缺少账号"（buildReservation 内部现在两个平台共用同一段逻辑）。
    [{ recordId: 'rec_1', xiaohongshuAccount: '', xiaohongshuStatus: '待发布', publishTime: 1784051200000 }, /缺少账号/],
    [{ recordId: 'rec_1', xiaohongshuAccount: '可乐', xiaohongshuStatus: '待发布', publishTime: '不是时间' }, /发布时间无效/],
    [{ recordId: 'rec_1', xiaohongshuAccount: '可乐', xiaohongshuStatus: '待发布', publishTime: new Date('invalid') }, /发布时间无效/],
  ]) {
    assert.throws(() => collectIndexedReservations(makeArgs(record)), error => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, message);
      return true;
    });
  }
});

test('indexed reservation accepts only strict millisecond timestamps within 2000 through 2099', () => {
  const index = {
    version: 1,
    records: { rec_1: validEntry({ topicKey: '定语从句' }) },
  };
  const collectAt = publishTime => collectIndexedReservations({
    topicIndex: index,
    feishuRecords: [{
      recordId: 'rec_1',
      xiaohongshuAccount: '可乐',
      xiaohongshuStatus: '待发布',
      publishTime,
    }],
    history: {},
    accountGroups: { 可乐: '教师店' },
  });

  assert.equal(collectAt('1784051200000')[0].publishTime, 1784051200000);
  assert.equal(collectAt('2026-07-16T08:00:00+08:00')[0].publishTime, 1784160000000);

  for (const invalidTime of [
    new Date('1999-12-31T23:59:59.999Z'),
    new Date('2100-01-01T00:00:00.000Z'),
    1784051200000.5,
    0,
    -1784051200000,
    1784051200,
    '0',
    '-1784051200000',
    '1784051200',
    '1.7840512e12',
  ]) {
    assert.throws(() => collectAt(invalidTime), error => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /发布时间无效/);
      return true;
    }, `应拒绝时间 ${String(invalidTime)}`);
  }
});

test('same indexed publish fact is not duplicated between scheduled records and history', () => {
  const reservations = collectIndexedReservations({
    topicIndex: { version: 1, records: { rec_1: validEntry({ topicKey: '定语从句' }) } },
    feishuRecords: [{ recordId: 'rec_1', xiaohongshuAccount: '可乐', xiaohongshuStatus: '发布中', publishTime: 1784051200000 }],
    history: { rec_1: { 小红书: [
      { accountName: '可乐', at: 1784051200000 },
      { accountName: '可乐', at: 1784051200000 },
    ] } },
    accountGroups: { 可乐: '教师店' },
  });

  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].state, 'published');
});

test('published history replaces a different scheduled time but keeps distinct real publishes', () => {
  const reservations = collectIndexedReservations({
    topicIndex: { version: 1, records: { rec_1: validEntry({ topicKey: '定语从句' }) } },
    feishuRecords: [{ recordId: 'rec_1', xiaohongshuAccount: '可乐', xiaohongshuStatus: '发布中', publishTime: 1784051200000 }],
    history: { rec_1: { 小红书: [
      { accountName: '可乐', at: 1784051300000 },
      { accountName: '可乐', at: 1784051400000 },
      { accountName: '可乐', at: 1784051400000 },
    ] } },
    accountGroups: { 可乐: '教师店' },
  });

  assert.deepEqual(reservations.map(item => [item.state, item.publishTime]), [
    ['published', 1784051300000],
    ['published', 1784051400000],
  ]);
});

test('same store group and exact topic across accounts creates one stable conflict', () => {
  const currentItems = [
    { noteKey: 'new/2', topicKey: '定语从句', displayTopic: '定语从句', account: '拉面卷卷', storeGroup: '教师店' },
    { noteKey: 'new/1', topicKey: '定语从句', displayTopic: '定语从句', account: '拉面卷卷', storeGroup: '教师店' },
  ];
  const reservations = [
    { recordId: 'rec_1', topicKey: '定语从句', displayTopic: '定语从句', account: '可乐', storeGroup: '教师店', publishTime: 1784051200000 },
  ];
  const first = findCrossAccountTopicConflicts({ currentItems, reservations });
  const second = findCrossAccountTopicConflicts({ currentItems: currentItems.slice().reverse(), reservations });

  assert.equal(first.length, 1);
  assert.equal(first[0].topicKey, '定语从句');
  assert.deepEqual(first[0].accounts, ['可乐', '拉面卷卷']);
  assert.equal(first[0].id, second[0].id);
});

test('conflict detection fails closed when current or reservation context is incomplete', () => {
  const validCurrent = { noteKey: 'new/1', topicKey: '定语从句', account: '拉面卷卷', storeGroup: '教师店' };
  const validReservation = { recordId: 'rec_1', topicKey: '定语从句', account: '可乐', storeGroup: '教师店', publishTime: 1784051200000 };
  const cases = [
    { currentItems: [{ ...validCurrent, topicKey: '', displayTopic: '' }], reservations: [validReservation], message: /缺少具体主题/ },
    { currentItems: [{ ...validCurrent, account: '' }], reservations: [validReservation], message: /缺少账号/ },
    { currentItems: [{ ...validCurrent, storeGroup: '' }], reservations: [validReservation], message: /缺少店铺组/ },
    { currentItems: [validCurrent], reservations: [{ ...validReservation, account: '' }], message: /缺少账号/ },
  ];

  for (const item of cases) {
    assert.throws(() => findCrossAccountTopicConflicts(item), error => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, item.message);
      return true;
    });
  }
});

test('different concrete topics, reservation-only groups, and different platforms do not conflict', () => {
  // 分组键改为「平台 + 主题」之后，跨店铺同主题不再天然免检——那正是本次重写要新增的能力
  // （规则 A 需要跨店铺也能比到一起才谈得上硬约束），已经拆到下面新增的用例单独验证。
  // 这里只保留真正"不该冲突"的三种情形：不同具体主题、只有历史预约没有本批条目的组、
  // 以及不同平台。
  assert.deepEqual(findCrossAccountTopicConflicts({
    currentItems: [
      { noteKey: 'new/1', topicKey: '剧本杀英语/定语从句', account: '拉面卷卷', storeGroup: '教师店' },
      { noteKey: 'new/2', topicKey: '剧本杀英语/被动语态', account: '可乐', storeGroup: '教师店' },
      { noteKey: 'new/3', topicKey: '同平台不同店主题', account: '账号甲', storeGroup: '店A', platform: 'xiaohongshu' },
    ],
    reservations: [
      // 孤立主题：两条都是 reservation，没有本批条目参与，整组被跳过（不构成冲突）
      { recordId: 'rec_2', topicKey: '孤立主题', account: '账号丙', storeGroup: '店C', publishTime: 2 },
      { recordId: 'rec_3', topicKey: '孤立主题', account: '账号丁', storeGroup: '店C', publishTime: 3 },
      // 平台不同：即使账号、主题、店铺都对得上，分组键含 platform，不会和上面的
      // "同平台不同店主题"分到一组
      { recordId: 'rec_4', topicKey: '同平台不同店主题', account: '账号乙', storeGroup: '店B', publishTime: 4, platform: 'douyin' },
    ],
  }), []);
});

test('跨店铺同主题现在会产出冲突，且标记为 cross_store（硬约束）；同店铺标记为 same_store（需审批）', () => {
  const crossStore = findCrossAccountTopicConflicts({
    currentItems: [
      { noteKey: 'new/3', topicKey: '期末复习', account: '账号甲', storeGroup: '店A' },
    ],
    reservations: [
      { recordId: 'rec_1', topicKey: '期末复习', account: '账号乙', storeGroup: '店B', publishTime: 1 },
    ],
  });
  assert.equal(crossStore.length, 1);
  assert.equal(crossStore[0].scope, 'cross_store');
  assert.equal(crossStore[0].scopeLabel, '跨店铺（硬约束）');
  assert.deepEqual(crossStore[0].storeGroups, ['店A', '店B']);
  assert.equal(crossStore[0].platform, 'xiaohongshu'); // 未传 platform 时向后兼容默认小红书

  const sameStore = findCrossAccountTopicConflicts({
    currentItems: [
      { noteKey: 'new/3', topicKey: '期末复习', account: '账号甲', storeGroup: '店A' },
    ],
    reservations: [
      { recordId: 'rec_1', topicKey: '期末复习', account: '账号乙', storeGroup: '店A', publishTime: 1 },
    ],
  });
  assert.equal(sameStore.length, 1);
  assert.equal(sameStore[0].scope, 'same_store');
  assert.equal(sameStore[0].scopeLabel, '同店铺（需审批）');
  assert.deepEqual(sameStore[0].storeGroups, ['店A']);
});

test('collectIndexedReservations：抖音分支（douyinAccount/douyinStatus/抖音历史键）与小红书并行工作', () => {
  const topicIndex = {
    version: 1,
    records: {
      rec_dy_pending: validEntry({ topicKey: '抖音主题', noteKey: 'dy/1' }),
      rec_dy_published: validEntry({ topicKey: '抖音主题', noteKey: 'dy/2' }),
    },
  };
  const feishuRecords = [
    { recordId: 'rec_dy_pending', douyinAccount: '抖音号A', douyinStatus: '待发布', publishTime: 1784051200000 },
  ];
  const history = {
    rec_dy_published: { 抖音: [{ accountName: '抖音号B', at: 1784051500000 }] },
  };
  const reservations = collectIndexedReservations({
    topicIndex,
    feishuRecords,
    history,
    accountGroups: { 抖音号A: '抖音店', 抖音号B: '抖音店' },
  });
  assert.deepEqual(
    reservations.map(item => [item.recordId, item.platform, item.account, item.state]).sort(),
    [
      ['rec_dy_pending', 'douyin', '抖音号A', 'scheduled'],
      ['rec_dy_published', 'douyin', '抖音号B', 'published'],
    ]
  );
});

test('collectIndexedReservations：同一条记录小红书和抖音字段互不干扰，各自出一条', () => {
  const topicIndex = { version: 1, records: { rec_1: validEntry({ topicKey: '定语从句', noteKey: 'a/1' }) } };
  const reservations = collectIndexedReservations({
    topicIndex,
    feishuRecords: [{
      recordId: 'rec_1',
      xiaohongshuAccount: '可乐',
      xiaohongshuStatus: '待发布',
      douyinAccount: '抖音可乐',
      douyinStatus: '待发布',
      publishTime: 1784051200000,
    }],
    history: {},
    accountGroups: { 可乐: '教师店', 抖音可乐: '教师店' },
  });
  assert.deepEqual(
    reservations.map(item => `${item.platform}:${item.account}`).sort(),
    ['douyin:抖音可乐', 'xiaohongshu:可乐']
  );
});

test('collectIndexedReservations：某记录只在一个平台活跃时，另一个平台不误报"缺少账号"', () => {
  // 纯小红书记录：douyinStatus/douyinAccount 天然为空，抖音这一路应该被状态门（不在
  // ACTIVE_PLATFORM_STATUSES 里）挡住，根本不会走到"缺少账号"的 fail-closed 分支。
  const topicIndex = { version: 1, records: { rec_1: validEntry({ topicKey: '定语从句', noteKey: 'a/1' }) } };
  const reservations = collectIndexedReservations({
    topicIndex,
    feishuRecords: [{ recordId: 'rec_1', xiaohongshuAccount: '可乐', xiaohongshuStatus: '待发布', publishTime: 1784051200000 }],
    history: {},
    accountGroups: { 可乐: '教师店' },
  });
  assert.deepEqual(reservations.map(item => `${item.platform}:${item.account}`), ['xiaohongshu:可乐']);
});

test('confirmation requires exact fingerprint and every conflict id', () => {
  const input = { seed: 'batch-1', noteFolders: [{ topic: '定语从句', templates: ['1'] }] };
  const fingerprint = buildTopicCheckFingerprint(input);
  const conflicts = [{ id: 'conflict-a' }, { id: 'conflict-b' }];

  assert.equal(validateTopicConfirmation({ fingerprint, conflicts: [], confirmation: null }), true);
  assert.equal(validateTopicConfirmation({
    fingerprint,
    conflicts,
    confirmation: { inputFingerprint: fingerprint, decision: 'auto_space', conflictIds: ['conflict-b', 'conflict-a'] },
  }), true);

  for (const [confirmation, message] of [
    [{ inputFingerprint: buildTopicCheckFingerprint({ ...input, seed: 'batch-0' }), decision: 'allow_conflicts', conflictIds: ['conflict-a', 'conflict-b'] }, /确认已失效/],
    [{ inputFingerprint: fingerprint, decision: 'allow_conflicts', conflictIds: ['conflict-a'] }, /未确认/],
    [{ inputFingerprint: fingerprint, decision: 'allow_conflicts', conflictIds: ['conflict-a', 'conflict-b', 'conflict-old'] }, /不属于当前检查/],
    [{ inputFingerprint: fingerprint, decision: 'adjust_window', conflictIds: ['conflict-a', 'conflict-b'] }, /修改输入后重新检查/],
    [{ inputFingerprint: fingerprint, decision: 'unknown', conflictIds: ['conflict-a', 'conflict-b'] }, /决定无效/],
  ]) {
    assert.throws(() => validateTopicConfirmation({ fingerprint, conflicts, confirmation }), error => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, message);
      return true;
    });
  }
});
