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
