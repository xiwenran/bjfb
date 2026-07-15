# Topic Spacing and Batch Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为知发新增记录建立可靠主题索引，在生成排期前完成跨账号同主题确认，并以同账号最小 361 分钟、固定 seed 分层随机和全批分钟唯一的硬约束生成可复算排期。

**Architecture:** `config-store.js` 只负责 `topic-index.json` 的版本化原子读写，`topic-spacing-guard.js` 只负责主题标准化、输入摘要、已有记录关联、冲突与确认判断，`scheduler-allocator.js` 只负责确定性分层随机和时间容量分配。`server.js` 统一读取飞书、主题索引和发布历史，并为检查接口、排期接口、创建记录接口提供单一门禁；Python 上传入口先检查、取得本批确认，再请求排期，两个 Skill 只描述同一入口而不复制算法。

**Tech Stack:** Node.js CommonJS、Node.js 内置 `node:test` / `assert` / `crypto` / `fs`、现有 Node HTTP 服务、Python 3 标准库、Markdown。

---

## File map

- Create `src/topic-spacing-guard.js`: 主题标准化、稳定输入摘要、主题索引与飞书／发布历史关联、跨账号同主题冲突、确认校验。
- Modify `src/config-store.js`: 增加 `topic-index.json` 路径、版本校验、fail-closed 读取、原子保存和单记录登记。
- Modify `src/server.js`: 读取上线后新增记录上下文，提供排期前检查接口，在排期接口校验确认，在创建飞书记录成功后登记主题。
- Modify `src/scheduler-allocator.js`: 固定 seed 的分层随机、全批分钟唯一、同账号严格大于 6 小时、既有保留时间参与计算、容量不足明确失败。
- Modify `scripts/skill_upload.py`: `schedule` 命令先执行主题检查，传递确认选择、时间窗和 seed，拒绝沿用输入已变化的确认。
- Create `tests/topic-spacing-guard.test.js`: 覆盖索引读写错误、标准化、旧记录排除、冲突和确认失效。
- Modify `tests/scheduler-allocator.test.js`: 覆盖 360/361 分钟边界、当前批与已有保留时间、seed、分层随机、分钟唯一和容量失败。
- Modify `tests/server-import-create-records.test.js`: 覆盖检查接口、排期门禁、输入变化失效和创建成功后主题登记。
- Modify `skills/zhifa-upload/SKILL.md`: 固化「先检查和询问，再生成排期」及三种决定。
- Modify `skills/zhifa-pipeline/SKILL.md`: 全链路复用 `zhifa-upload` 的唯一排期入口。
- Modify `README.md`: 用户可见的 361 分钟、同主题确认、08:00—12:00 默认窗口、seed 与失败语义。
- Modify `docs/roadmap.md`: 施工前保持 🚧；实现和验证完成后改为 ✅ 并写实现 commit 与验证证据。

### Task 1: Versioned topic index with atomic fail-closed storage

**Files:**
- Modify: `src/config-store.js`
- Create: `tests/topic-spacing-guard.test.js`

- [ ] **Step 1: Write failing topic-index storage tests**

Create `tests/topic-spacing-guard.test.js` with storage cases first:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zhifa-topic-spacing-'));
process.env.NOTE_PUBLISHER_DATA_DIR = tempRoot;

const {
  getRuntimePaths,
  readTopicIndex,
  saveTopicIndex,
  upsertTopicIndexRecord,
} = require('../src/config-store.js');

test('topic index starts empty and upsert persists version 1 atomically', () => {
  const paths = getRuntimePaths();
  fs.rmSync(paths.topicIndexPath, { force: true });
  assert.deepEqual(readTopicIndex(), { version: 1, records: {} });

  upsertTopicIndexRecord('rec_1', {
    topicKey: '剧本杀版英语语法/定语从句',
    displayTopic: '定语从句',
    noteKey: '英语/剧本杀/定语从句/001',
    createdAt: 1784051200000,
    source: 'import',
  });

  assert.equal(readTopicIndex().records.rec_1.topicKey, '剧本杀版英语语法/定语从句');
  assert.equal(fs.existsSync(`${paths.topicIndexPath}.tmp`), false);
});

test('topic index fails closed on malformed JSON and unsupported version', () => {
  const paths = getRuntimePaths();
  fs.writeFileSync(paths.topicIndexPath, '{broken', 'utf8');
  assert.throws(() => readTopicIndex(), /读取主题索引失败/);

  fs.writeFileSync(paths.topicIndexPath, JSON.stringify({ version: 2, records: {} }), 'utf8');
  assert.throws(() => readTopicIndex(), /不支持的主题索引版本: 2/);
});

test('topic index rejects invalid records instead of treating them as empty', () => {
  assert.throws(
    () => saveTopicIndex({ version: 1, records: { rec_1: { displayTopic: '定语从句' } } }),
    /topicKey/
  );
});
```

- [ ] **Step 2: Run the storage tests to verify RED**

Run: `node --test tests/topic-spacing-guard.test.js`

Expected: FAIL during module use because `readTopicIndex`, `saveTopicIndex`, `upsertTopicIndexRecord`, or `topicIndexPath` is not defined.

- [ ] **Step 3: Implement versioned atomic topic-index storage**

In `getRuntimePaths()` add:

```js
topicIndexPath: path.join(dataDir, 'topic-index.json'),
```

Add these functions before `module.exports` in `src/config-store.js`:

```js
const TOPIC_INDEX_VERSION = 1;

function createEmptyTopicIndex() {
  return { version: TOPIC_INDEX_VERSION, records: {} };
}

function validateTopicIndex(data) {
  if (!isPlainObject(data)) throw new Error('主题索引必须是 JSON 对象');
  if (data.version !== TOPIC_INDEX_VERSION) {
    throw new Error(`不支持的主题索引版本: ${String(data.version)}`);
  }
  if (!isPlainObject(data.records)) throw new Error('主题索引 records 必须是对象');
  for (const [recordId, entry] of Object.entries(data.records)) {
    if (!recordId || !isPlainObject(entry)) throw new Error(`主题索引记录无效: ${recordId}`);
    if (!String(entry.topicKey || '').trim()) throw new Error(`主题索引记录缺少 topicKey: ${recordId}`);
    if (!String(entry.displayTopic || '').trim()) throw new Error(`主题索引记录缺少 displayTopic: ${recordId}`);
    if (!String(entry.noteKey || '').trim()) throw new Error(`主题索引记录缺少 noteKey: ${recordId}`);
    if (!Number.isFinite(entry.createdAt)) throw new Error(`主题索引记录缺少 createdAt: ${recordId}`);
    if (entry.source !== 'import') throw new Error(`主题索引记录 source 无效: ${recordId}`);
  }
  return data;
}

function readTopicIndex() {
  const paths = getRuntimePaths();
  if (!fs.existsSync(paths.topicIndexPath)) return createEmptyTopicIndex();
  try {
    return validateTopicIndex(JSON.parse(fs.readFileSync(paths.topicIndexPath, 'utf8')));
  } catch (error) {
    throw new Error(`读取主题索引失败: ${error.message}`);
  }
}

function saveTopicIndex(data) {
  const paths = getRuntimePaths();
  ensureRuntimeDirs(paths);
  const validated = validateTopicIndex(data);
  writeJsonFileAtomic(paths.topicIndexPath, validated);
  return validated;
}

function upsertTopicIndexRecord(recordId, entry) {
  const normalizedRecordId = String(recordId || '').trim();
  if (!normalizedRecordId) throw new Error('登记主题索引需要 recordId');
  const index = readTopicIndex();
  index.records[normalizedRecordId] = { ...entry };
  saveTopicIndex(index);
  return index.records[normalizedRecordId];
}
```

Export `TOPIC_INDEX_VERSION`, `readTopicIndex`, `saveTopicIndex`, and `upsertTopicIndexRecord` from `module.exports`.

- [ ] **Step 4: Run storage tests to verify GREEN**

Run: `node --test tests/topic-spacing-guard.test.js`

Expected: PASS for all three storage tests; malformed JSON and version 2 both throw rather than returning an empty index.

- [ ] **Step 5: Commit storage boundary**

```bash
git add src/config-store.js tests/topic-spacing-guard.test.js
git commit -m "feat: 增加主题索引原子读写与损坏阻断"
```

### Task 2: Pure topic normalization, context linking, conflict detection, and confirmation

**Files:**
- Create: `src/topic-spacing-guard.js`
- Modify: `tests/topic-spacing-guard.test.js`

- [ ] **Step 1: Add failing pure-function tests**

Append to `tests/topic-spacing-guard.test.js`:

```js
const {
  normalizeTopicKey,
  buildTopicCheckFingerprint,
  collectIndexedReservations,
  findCrossAccountTopicConflicts,
  validateTopicConfirmation,
} = require('../src/topic-spacing-guard.js');

test('topic normalization is deterministic but preserves meaning-bearing words', () => {
  assert.equal(normalizeTopicKey(' 剧本杀版英语语法／ 定语从句　'), '剧本杀版英语语法/ 定语从句');
  assert.notEqual(normalizeTopicKey('分数除法（一）'), normalizeTopicKey('分数除法（二）'));
  assert.notEqual(normalizeTopicKey('定语从句'), normalizeTopicKey('被动语态'));
});

test('only indexed records become scheduled or published reservations and store groups come from payload mapping', () => {
  const topicIndex = {
    version: 1,
    records: {
      rec_pending: { topicKey: '定语从句', displayTopic: '定语从句', noteKey: 'a/1', createdAt: 1, source: 'import' },
      rec_published: { topicKey: '定语从句', displayTopic: '定语从句', noteKey: 'a/2', createdAt: 2, source: 'import' },
    },
  };
  const feishuRecords = [
    { recordId: 'rec_old', xiaohongshuAccount: '旧账号', xiaohongshuStatus: '待发布', publishTime: 1784051200000 },
    { recordId: 'rec_pending', xiaohongshuAccount: '可乐', xiaohongshuStatus: '待发布', publishTime: 1784051200000 },
  ];
  const history = {
    rec_old: { 小红书: [{ accountName: '旧账号', at: 1784051300000 }] },
    rec_published: { 小红书: [{ accountName: '拉面卷卷', at: 1784051400000 }] },
  };
  const accountGroups = { 可乐: '教师店', 拉面卷卷: '教师店' };
  const reservations = collectIndexedReservations({ topicIndex, feishuRecords, history, accountGroups });
  assert.deepEqual(reservations.map(item => item.recordId).sort(), ['rec_pending', 'rec_published']);
  assert.ok(reservations.every(item => item.storeGroup === '教师店'));
});

test('indexed reservation rejects an account missing from payload accountGroups', () => {
  assert.throws(() => collectIndexedReservations({
    topicIndex: {
      version: 1,
      records: { rec_1: { topicKey: '定语从句', displayTopic: '定语从句', noteKey: 'a/1', createdAt: 1, source: 'import' } },
    },
    feishuRecords: [{ recordId: 'rec_1', xiaohongshuAccount: '可乐', xiaohongshuStatus: '待发布', publishTime: 1784051200000 }],
    history: {},
    accountGroups: {},
  }), /账号“可乐”未配置店铺组/);
});

test('same store group and topic across accounts creates one stable conflict', () => {
  const conflicts = findCrossAccountTopicConflicts({
    currentItems: [{ noteKey: 'new/1', topicKey: '定语从句', displayTopic: '定语从句', account: '拉面卷卷', storeGroup: '教师店' }],
    reservations: [{ recordId: 'rec_1', topicKey: '定语从句', displayTopic: '定语从句', account: '可乐', storeGroup: '教师店', publishTime: 1784051200000 }],
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].topicKey, '定语从句');
  assert.deepEqual(conflicts[0].accounts.sort(), ['可乐', '拉面卷卷']);
});

test('confirmation is bound to exact input and only approved conflicts', () => {
  const input = { seed: 'batch-1', noteFolders: [{ topic: '定语从句', templates: ['1'] }] };
  const fingerprint = buildTopicCheckFingerprint(input);
  const conflicts = [{ id: 'conflict-a' }];
  assert.doesNotThrow(() => validateTopicConfirmation({
    fingerprint,
    conflicts,
    confirmation: { inputFingerprint: fingerprint, decision: 'allow_conflicts', conflictIds: ['conflict-a'] },
  }));
  assert.throws(() => validateTopicConfirmation({
    fingerprint: buildTopicCheckFingerprint({ ...input, seed: 'batch-2' }),
    conflicts,
    confirmation: { inputFingerprint: fingerprint, decision: 'allow_conflicts', conflictIds: ['conflict-a'] },
  }), /确认已失效/);
});
```

- [ ] **Step 2: Run guard tests to verify RED**

Run: `node --test tests/topic-spacing-guard.test.js`

Expected: FAIL with `Cannot find module '../src/topic-spacing-guard.js'`.

- [ ] **Step 3: Implement the pure guard module**

Create `src/topic-spacing-guard.js` with these public contracts and no filesystem or network access:

```js
const crypto = require('crypto');

const ALLOWED_DECISIONS = new Set(['auto_space', 'adjust_window', 'allow_conflicts']);
const ACTIVE_STATUSES = new Set(['待处理', '待发布', '发布中']);

function normalizeTopicKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/／/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function buildTopicCheckFingerprint(input) {
  const relevant = {
    noteFolders: input?.noteFolders || [],
    accounts: input?.accounts || {},
    accountGroups: input?.accountGroups || {},
    timeSlots: input?.timeSlots || {},
    timeWindows: input?.timeWindows || {},
    perAccountPerSlot: input?.perAccountPerSlot || 1,
    seed: String(input?.seed || ''),
  };
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(relevant))).digest('hex');
}

function collectIndexedReservations({ topicIndex, feishuRecords, history, accountGroups }) {
  const parsedById = new Map((feishuRecords || []).map(item => [String(item.recordId || ''), item]));
  const reservations = [];
  const resolveStoreGroup = account => {
    const normalizedAccount = String(account || '').trim();
    const storeGroup = String(accountGroups?.[normalizedAccount] || '').trim();
    if (!storeGroup) {
      const error = new Error(`账号“${normalizedAccount || '未知'}”未配置店铺组，无法检查同主题间隔`);
      error.statusCode = 400;
      throw error;
    }
    return storeGroup;
  };
  for (const [recordId, indexed] of Object.entries(topicIndex.records || {})) {
    const pending = parsedById.get(recordId);
    if (pending && ACTIVE_STATUSES.has(String(pending.xiaohongshuStatus || pending.status || '').trim())) {
      const account = String(pending.xiaohongshuAccount || '').trim();
      reservations.push({
        recordId,
        topicKey: indexed.topicKey,
        displayTopic: indexed.displayTopic,
        account,
        storeGroup: resolveStoreGroup(account),
        publishTime: Number(pending.publishTime),
        state: 'scheduled',
      });
    }
    const published = Array.isArray(history?.[recordId]?.['小红书']) ? history[recordId]['小红书'] : [];
    for (const entry of published) {
      const account = String(entry.accountName || '').trim();
      reservations.push({
        recordId,
        topicKey: indexed.topicKey,
        displayTopic: indexed.displayTopic,
        account,
        storeGroup: resolveStoreGroup(account),
        publishTime: Number(entry.at),
        state: 'published',
      });
    }
  }
  return reservations.filter(item => item.account && Number.isFinite(item.publishTime));
}

function makeConflictId(topicKey, storeGroup, accounts) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([topicKey, storeGroup, accounts.slice().sort()]))
    .digest('hex')
    .slice(0, 16);
}

function findCrossAccountTopicConflicts({ currentItems, reservations }) {
  const all = [...(currentItems || []), ...(reservations || [])];
  const grouped = new Map();
  for (const item of all) {
    const topicKey = normalizeTopicKey(item.topicKey || item.displayTopic);
    const storeGroup = String(item.storeGroup || '').trim();
    const account = String(item.account || '').trim();
    if (!topicKey || !storeGroup || !account) continue;
    const key = `${storeGroup}\u0000${topicKey}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ ...item, topicKey, storeGroup, account });
  }
  const conflicts = [];
  for (const items of grouped.values()) {
    const accounts = [...new Set(items.map(item => item.account))];
    const hasCurrent = items.some(item => item.noteKey);
    if (!hasCurrent || accounts.length < 2) continue;
    conflicts.push({
      id: makeConflictId(items[0].topicKey, items[0].storeGroup, accounts),
      topicKey: items[0].topicKey,
      displayTopic: items.find(item => item.displayTopic)?.displayTopic || items[0].topicKey,
      storeGroup: items[0].storeGroup,
      accounts,
      items,
    });
  }
  return conflicts.sort((a, b) => a.id.localeCompare(b.id));
}

function validateTopicConfirmation({ fingerprint, conflicts, confirmation }) {
  if ((conflicts || []).length === 0) return true;
  if (!confirmation || confirmation.inputFingerprint !== fingerprint) throw new Error('排期前同主题确认已失效，请重新检查');
  if (!ALLOWED_DECISIONS.has(confirmation.decision)) throw new Error('同主题确认决定无效');
  if (confirmation.decision === 'adjust_window') throw new Error('时间窗已要求调整，请修改输入后重新检查');
  const expected = new Set(conflicts.map(item => item.id));
  const approved = new Set(confirmation.conflictIds || []);
  if ([...expected].some(id => !approved.has(id))) throw new Error('仍有未确认的同主题冲突');
  return true;
}

module.exports = {
  normalizeTopicKey,
  buildTopicCheckFingerprint,
  collectIndexedReservations,
  findCrossAccountTopicConflicts,
  validateTopicConfirmation,
};
```

- [ ] **Step 4: Run pure guard tests to verify GREEN**

Run: `node --test tests/topic-spacing-guard.test.js`

Expected: PASS for storage, normalization, indexed-only linking, conflict detection, and input-bound confirmation.

- [ ] **Step 5: Commit pure guard behavior**

```bash
git add src/topic-spacing-guard.js tests/topic-spacing-guard.test.js
git commit -m "feat: 增加同主题冲突判断与确认失效校验"
```

### Task 3: Server-side context loading and pre-schedule check endpoint

**Files:**
- Modify: `src/server.js`
- Modify: `tests/server-import-create-records.test.js`

- [ ] **Step 1: Add failing endpoint tests for indexed-only reservations and conflict summaries**

Extend the server test setup to preserve and stub `FeishuClient.prototype.getRecords`, then add a serial test that writes a version-1 topic index and publish history under `NOTE_PUBLISHER_DATA_DIR`. Send:

```js
const checkResponse = await requestJson({
  method: 'POST',
  urlPath: '/api/import/topic-spacing-check',
  body: {
    seed: 'batch-20260715',
    noteFolders: [{ topic: '定语从句', templates: ['001'] }],
    accounts: { xiaohongshu_regular: ['拉面卷卷'], xiaohongshu_special: [], douyin: [] },
    accountGroups: { 拉面卷卷: '教师店', 可乐: '教师店' },
    timeSlots: { regular: ['2026-07-16 08:00 - 12:00'], special: [] },
  },
});
assert.equal(checkResponse.statusCode, 200);
assert.equal(checkResponse.body.requiresConfirmation, true);
assert.equal(checkResponse.body.conflicts.length, 1);
assert.match(checkResponse.body.conflicts[0].displayTopic, /定语从句/);
assert.match(checkResponse.body.inputFingerprint, /^[a-f0-9]{64}$/);
```

Also write malformed JSON to `topic-index.json` and assert the same endpoint returns status 500 with `读取主题索引失败`, proving the route is fail-closed.

- [ ] **Step 2: Run endpoint tests to verify RED**

Run: `node --test tests/server-import-create-records.test.js`

Expected: FAIL because `/api/import/topic-spacing-check` returns 404.

- [ ] **Step 3: Add a single server context loader and the check route**

Import from `config-store.js` and `topic-spacing-guard.js`:

```js
const { readTopicIndex, readHistory, upsertTopicIndexRecord } = require('./config-store.js');
const {
  normalizeTopicKey,
  buildTopicCheckFingerprint,
  collectIndexedReservations,
  findCrossAccountTopicConflicts,
  validateTopicConfirmation,
} = require('./topic-spacing-guard.js');
```

Add helpers next to the existing import helpers:

```js
function buildPotentialCurrentTopicItems(payload) {
  const noteFolders = Array.isArray(payload.noteFolders) ? payload.noteFolders : [];
  const accounts = payload.accounts || {};
  const candidateAccounts = [...new Set([
    ...(Array.isArray(accounts.xiaohongshu_regular) ? accounts.xiaohongshu_regular : []),
    ...(Array.isArray(accounts.xiaohongshu_special) ? accounts.xiaohongshu_special : []),
  ].map(value => String(value || '').trim()).filter(Boolean))];
  if (noteFolders.length === 0 || candidateAccounts.length === 0) {
    throw Object.assign(new Error('排期检查需要 noteFolders 和本批候选小红书账号'), { statusCode: 400 });
  }
  return noteFolders.flatMap((folder, folderIndex) => {
    const displayTopic = String(folder.pptTopic || folder.topicOverride || folder.topic || '').trim();
    const topicKey = normalizeTopicKey([
      folder.contentGroup || folder.topic,
      folder.pptTopic || folder.topicOverride,
    ].filter(Boolean).join('/'));
    if (!topicKey || !displayTopic) {
      throw Object.assign(new Error(`noteFolders[${folderIndex}] 缺少具体主题`), { statusCode: 400 });
    }
    return candidateAccounts.map(account => {
      const storeGroup = String(payload.accountGroups?.[account] || '').trim();
      if (!storeGroup) {
        throw Object.assign(new Error(`账号“${account}”未配置店铺组，无法检查同主题间隔`), { statusCode: 400 });
      }
      return {
        noteKey: String(folder.noteKey || `${topicKey}/${folderIndex + 1}`),
        topicKey,
        displayTopic,
        account,
        storeGroup,
        potential: true,
      };
    });
  });
}

async function loadTopicSpacingContext(payload) {
  const topicIndex = readTopicIndex();
  let rawRecords;
  try {
    rawRecords = await feishu.getRecords();
  } catch (error) {
    throw new Error(`读取飞书新增记录失败: ${error.message}`);
  }
  let history;
  try {
    history = readHistory();
  } catch (error) {
    throw new Error(`读取发布历史失败: ${error.message}`);
  }
  const parsedRecords = rawRecords.map(record => feishu.parseRecord(record));
  const reservations = collectIndexedReservations({
    topicIndex,
    feishuRecords: parsedRecords,
    history,
    accountGroups: payload.accountGroups,
  });
  const currentItems = buildPotentialCurrentTopicItems(payload);
  const conflicts = findCrossAccountTopicConflicts({ currentItems, reservations });
  return {
    currentItems,
    reservations,
    conflicts,
    inputFingerprint: buildTopicCheckFingerprint(payload),
  };
}
```

Add the route before `/api/import/schedule`:

```js
if (pathname === '/api/import/topic-spacing-check' && req.method === 'POST') {
  readBody(req).then(async body => {
    try {
      ensureFeishuConfigReady();
      const payload = JSON.parse(body || '{}');
      const context = await loadTopicSpacingContext(payload);
      return sendJson(res, {
        inputFingerprint: context.inputFingerprint,
        requiresConfirmation: context.conflicts.length > 0,
        conflicts: context.conflicts,
        reservationCount: context.reservations.length,
        choices: ['auto_space', 'adjust_window', 'allow_conflicts'],
      });
    } catch (error) {
      return sendJson(res, { error: error.message }, error.statusCode || (error instanceof SyntaxError ? 400 : 500));
    }
  }).catch(error => sendJson(res, { error: error.message }, error.statusCode || 500));
  return;
}
```

- [ ] **Step 4: Run endpoint tests to verify GREEN**

Run: `node --test tests/server-import-create-records.test.js`

Expected: PASS; only records present in `topic-index.json` influence `reservationCount`, and malformed topic index returns 500.

- [ ] **Step 5: Commit the server pre-check**

```bash
git add src/server.js tests/server-import-create-records.test.js
git commit -m "feat: 增加排期前同主题检查接口"
```

### Task 4: Deterministic stratified allocator with 361-minute hard spacing

**Files:**
- Modify: `src/scheduler-allocator.js`
- Modify: `tests/scheduler-allocator.test.js`

- [ ] **Step 1: Replace optional-spacing expectations with failing hard-boundary tests**

Keep the cross-platform note reuse test. Replace the two optional 360-minute tests and add deterministic distribution tests:

```js
test('same account requires at least 361 minutes across current and reserved records', () => {
  assert.throws(() => allocateImportSchedule({
    seed: 'spacing-boundary',
    noteFolders: buildNoteFolders('教务类/期末复习', 1),
    currentItems: [{ noteKey: '教务类/期末复习/1', topicKey: '教务类/期末复习', displayTopic: '期末复习', account: '浅浅', storeGroup: '教师店' }],
    accounts: { xiaohongshu_regular: ['浅浅'], xiaohongshu_special: [], douyin: [] },
    timeSlots: { regular: ['2026-06-15 15:00'], special: [] },
    existingReservations: [{ platform: 'xiaohongshu', account: '浅浅', publishTime: '2026-06-15 09:00' }],
    coverageStrategy: 'minimum',
  }), /至少间隔 361 分钟/);

  const result = allocateImportSchedule({
    seed: 'spacing-boundary',
    noteFolders: buildNoteFolders('教务类/期末复习', 1),
    currentItems: [{ noteKey: '教务类/期末复习/1', topicKey: '教务类/期末复习', displayTopic: '期末复习', account: '浅浅', storeGroup: '教师店' }],
    accounts: { xiaohongshu_regular: ['浅浅'], xiaohongshu_special: [], douyin: [] },
    timeSlots: { regular: ['2026-06-15 15:01'], special: [] },
    existingReservations: [{ platform: 'xiaohongshu', account: '浅浅', publishTime: '2026-06-15 09:00' }],
    coverageStrategy: 'minimum',
  });
  assert.equal(result.schedule[0].publishTime, '2026-06-15 15:01');
  assert.equal(result.constraints.minSameAccountIntervalMinutes, 361);
});

test('stratified windows are seed-repeatable and unique by minute', () => {
  const input = {
    seed: 'teacher-batch-1',
    noteFolders: buildNoteFolders('剧本杀英语/定语从句', 4),
    currentItems: Array.from({ length: 4 }, (_, index) => ({ noteKey: `剧本杀英语/定语从句/${index + 1}`, topicKey: '剧本杀英语/定语从句', displayTopic: '定语从句', account: `账号${index + 1}`, storeGroup: '教师店' })),
    accounts: { xiaohongshu_regular: ['账号1', '账号2', '账号3', '账号4'], xiaohongshu_special: [], douyin: [] },
    timeSlots: { regular: ['2026-07-16 08:00 - 12:00'], special: [] },
    coverageStrategy: 'minimum',
  };
  const first = allocateImportSchedule(input);
  const second = allocateImportSchedule(input);
  assert.deepEqual(first.schedule, second.schedule);
  const minutes = first.schedule.map(item => item.publishTime);
  assert.equal(new Set(minutes).size, minutes.length);
  assert.ok(minutes.some(value => value < '2026-07-16 09:00'));
  assert.ok(minutes.some(value => value >= '2026-07-16 11:00'));
});

test('allocator fails instead of partial scheduling when minute capacity is insufficient', () => {
  assert.throws(() => allocateImportSchedule({
    seed: 'capacity',
    noteFolders: buildNoteFolders('主题A', 3),
    currentItems: [
      { noteKey: '主题A/1', topicKey: '主题A', displayTopic: '主题A', account: '账号1', storeGroup: '店铺' },
      { noteKey: '主题A/2', topicKey: '主题A', displayTopic: '主题A', account: '账号2', storeGroup: '店铺' },
      { noteKey: '主题A/3', topicKey: '主题A', displayTopic: '主题A', account: '账号3', storeGroup: '店铺' },
    ],
    accounts: { xiaohongshu_regular: ['账号1', '账号2', '账号3'], xiaohongshu_special: [], douyin: [] },
    timeSlots: { regular: ['2026-07-16 09:00 - 09:01'], special: [] },
    coverageStrategy: 'minimum',
  }), /唯一分钟不足/);
});
```

- [ ] **Step 2: Run allocator tests to verify RED**

Run: `node --test tests/scheduler-allocator.test.js`

Expected: FAIL because exact 360 minutes is currently allowed when requested, spacing is optional by default, randomization uses `Math.random`, and insufficient capacity returns partial output.

- [ ] **Step 3: Add seeded PRNG and stratified window expansion**

Replace `shuffle(items)` with an injected RNG and add exact minute helpers:

```js
const MIN_SAME_ACCOUNT_INTERVAL_MINUTES = 361;

function createSeededRandom(seed) {
  let state = 2166136261;
  for (const char of String(seed || '')) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, rng) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function formatMinute(timestamp) {
  const date = new Date(timestamp);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseWindow(value) {
  const match = String(value || '').trim().match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (!match) return null;
  const start = parsePublishTimestamp(`${match[1]} ${match[2]}`);
  const end = parsePublishTimestamp(`${match[1]} ${match[3]}`);
  if (start === null || end === null || end < start) throw createInputError(`时间窗无效: ${value}`);
  return { start, end };
}

function stratifiedMinutes(windowValue, count, rng) {
  const window = parseWindow(windowValue);
  if (!window) return [String(windowValue || '').trim()];
  const totalMinutes = Math.floor((window.end - window.start) / 60000) + 1;
  if (totalMinutes < count) throw createInputError(`时间窗 ${windowValue} 的唯一分钟不足: 需要 ${count}，只有 ${totalMinutes}`);
  const result = [];
  for (let index = 0; index < count; index++) {
    const segmentStart = Math.floor(index * totalMinutes / count);
    const segmentEnd = Math.floor((index + 1) * totalMinutes / count) - 1;
    const offset = segmentStart + Math.floor(rng() * (segmentEnd - segmentStart + 1));
    result.push(formatMinute(window.start + offset * 60000));
  }
  return result;
}
```

Thread the same `rng = createSeededRandom(input.seed)` into every shuffle. Reject a missing seed with `createInputError('seed 不能为空，排期必须可复算')`. Expand each window with `stratifiedMinutes`, then allocate only from the expanded minute slots.

- [ ] **Step 4: Enforce global uniqueness, existing reservations, and hard spacing**

At allocation start create:

```js
const existingReservations = Array.isArray(input.existingReservations) ? input.existingReservations : [];
const usedMinutes = new Set(existingReservations.map(item => formatMinute(parsePublishTimestamp(item.publishTime))).filter(Boolean));
const accountTimes = new Map();
for (const item of existingReservations) {
  const timestamp = parsePublishTimestamp(item.publishTime);
  const key = `${String(item.platform || 'xiaohongshu')}:${String(item.account || '').trim()}`;
  if (timestamp === null || !item.account) throw createInputError('已有排期记录缺少可解析的账号或发布时间');
  if (!accountTimes.has(key)) accountTimes.set(key, []);
  accountTimes.get(key).push(timestamp);
}
```

Before accepting a candidate minute, require:

```js
function canPlaceAccountTime(times, candidate) {
  return (times || []).every(existing => Math.abs(candidate - existing) >= MIN_SAME_ACCOUNT_INTERVAL_MINUTES * 60000);
}

const minuteKey = formatMinute(slotTs);
if (usedMinutes.has(minuteKey)) continue;
const existingTimes = accountTimes.get(accountKey) || [];
if (!canPlaceAccountTime(existingTimes, slotTs)) continue;
usedMinutes.add(minuteKey);
existingTimes.push(slotTs);
accountTimes.set(accountKey, existingTimes);
```

After search, replace partial-output behavior with explicit failure:

```js
if (unscheduled.length > 0) {
  throw createInputError(`给定时间资源无法安排全部笔记：仍有 ${unscheduled.length} 篇；同账号必须至少间隔 361 分钟且全批分钟不能重复`);
}
result.constraints = {
  minSameAccountIntervalMinutes: MIN_SAME_ACCOUNT_INTERVAL_MINUTES,
  uniqueMinuteAcrossBatch: true,
  seed: String(input.seed),
};
```

The auto-space decision may search alternative stratified candidates, but it must use the same 361-minute check. `allow_conflicts` only skips cross-account same-topic spacing and must never bypass `canPlaceAccountTime`.

- [ ] **Step 5: Run allocator tests to verify GREEN and repeatability**

Run: `node --test tests/scheduler-allocator.test.js`

Expected: PASS; 15:00 against 09:00 is rejected, 15:01 is accepted, repeated seed output is byte-equivalent, all batch minutes are unique, and insufficient capacity throws status 400.

- [ ] **Step 6: Commit allocator hard constraints**

```bash
git add src/scheduler-allocator.js tests/scheduler-allocator.test.js
git commit -m "feat: 实现361分钟硬约束与分层随机排期"
```

### Task 5: Gate scheduling with fresh confirmation and server-owned reservations

**Files:**
- Modify: `src/server.js`
- Modify: `tests/server-import-create-records.test.js`

- [ ] **Step 1: Add failing schedule-gate integration tests**

Using the same check payload from Task 3, first POST `/api/import/schedule` without confirmation and assert:

```js
assert.equal(scheduleWithoutConfirmation.statusCode, 409);
assert.equal(scheduleWithoutConfirmation.body.code, 'topic_confirmation_required');
assert.equal(scheduleWithoutConfirmation.body.conflicts.length, 1);
```

Then POST the same payload with:

```js
confirmation: {
  inputFingerprint: checkResponse.body.inputFingerprint,
  decision: 'allow_conflicts',
  conflictIds: checkResponse.body.conflicts.map(item => item.id),
}
```

and assert status 200. Change the seed or time window while keeping the old confirmation and assert status 409 with `确认已失效`. Add one reservation for the same account exactly 360 minutes before the only candidate and assert status 400 even with `allow_conflicts`.

- [ ] **Step 2: Run server tests to verify RED**

Run: `node --test tests/server-import-create-records.test.js`

Expected: FAIL because `/api/import/schedule` currently calls the allocator directly and accepts an old or absent confirmation.

- [ ] **Step 3: Replace the schedule route with server-owned check and allocation**

Replace the `/api/import/schedule` route body with:

```js
if (pathname === '/api/import/schedule' && req.method === 'POST') {
  readBody(req).then(async body => {
    try {
      ensureFeishuConfigReady();
      const payload = JSON.parse(body || '{}');
      const context = await loadTopicSpacingContext(payload);
      try {
        validateTopicConfirmation({
          fingerprint: context.inputFingerprint,
          conflicts: context.conflicts,
          confirmation: payload.confirmation,
        });
      } catch (error) {
        return sendJson(res, {
          error: error.message,
          code: 'topic_confirmation_required',
          inputFingerprint: context.inputFingerprint,
          conflicts: context.conflicts,
        }, 409);
      }
      return sendJson(res, allocateImportSchedule({
        ...payload,
        existingReservations: context.reservations.map(item => ({
          platform: 'xiaohongshu',
          account: item.account,
          publishTime: item.publishTime,
          topicKey: item.topicKey,
          storeGroup: item.storeGroup,
        })),
        topicDecision: payload.confirmation?.decision || 'none',
      }));
    } catch (error) {
      return sendJson(res, { error: error.message }, error.statusCode || (error instanceof SyntaxError ? 400 : 500));
    }
  }).catch(error => sendJson(res, { error: error.message }, error.statusCode || 500));
  return;
}
```

Do not accept client-provided `existingReservations`; the server overwrites that field with the indexed context. Do not add a check to `publisher.js` or `scheduler.js`; the approved boundary is generation time, not real publish time.

- [ ] **Step 4: Run schedule-gate tests to verify GREEN**

Run: `node --test tests/server-import-create-records.test.js`

Expected: PASS for missing confirmation, exact-input confirmation, input-change invalidation, and 361-minute hard rejection.

- [ ] **Step 5: Commit the schedule gate**

```bash
git add src/server.js tests/server-import-create-records.test.js
git commit -m "feat: 在生成排期前校验同主题确认"
```

### Task 6: Register topic metadata immediately after each successful record creation

**Files:**
- Modify: `src/server.js`
- Modify: `tests/server-import-create-records.test.js`

- [ ] **Step 1: Add failing topic-registration tests**

Make the create-record stub return `rec_1`, send a non-dry-run record with `topic`, `pptTopic`, `noteKey`, and `accountGroup`, then assert:

```js
const topicIndex = JSON.parse(fs.readFileSync(path.join(tempRoot, 'data', 'topic-index.json'), 'utf8'));
assert.deepEqual(topicIndex.records.rec_1, {
  topicKey: '教务资料/期末家长会',
  displayTopic: '期末家长会',
  noteKey: '教务资料/期末家长会/001',
  createdAt: topicIndex.records.rec_1.createdAt,
  source: 'import',
});
assert.ok(Number.isFinite(topicIndex.records.rec_1.createdAt));
```

Assert dry-run does not create `topic-index.json`. Stub `upsertTopicIndexRecord` through a writable injected server dependency or force the index path unwritable, then assert the response does not report ordinary success: it must use `reason: 'topic_index_write_failed'` and stop processing later records.

- [ ] **Step 2: Run create-record tests to verify RED**

Run: `node --test tests/server-import-create-records.test.js`

Expected: FAIL because a successful `feishu.createRecord` does not yet write `topic-index.json`.

- [ ] **Step 3: Register the exact concrete topic after create/update succeeds**

Replace the local duplicate `normalizeTopicKey` in the create route with the imported function. Immediately after `createRecord` and before pushing a success result, add:

```js
const displayTopic = String(pptTopic || topicOverride || topic || '').trim();
const indexedTopicKey = normalizeTopicKey([contentGroup || topic, pptTopic || topicOverride]
  .filter(Boolean)
  .join('/'));
try {
  upsertTopicIndexRecord(recordId, {
    topicKey: indexedTopicKey,
    displayTopic,
    noteKey: String(noteKey || '').trim(),
    createdAt: Date.now(),
    source: 'import',
  });
} catch (error) {
  results.push({
    noteKey,
    status: 'failed',
    reason: 'topic_index_write_failed',
    recordId,
    message: `飞书记录已创建，但主题索引写入失败，已停止本批: ${error.message}`,
  });
  pushImportProgress(noteKey, 'failed');
  break;
}
```

For overwrite mode, upsert using `overwriteId` after `updateRecord`. Never register dry-run or fingerprint-skipped records. Preserve the returned `recordId` in the failure response because the external side effect already happened; do not claim rollback.

- [ ] **Step 4: Run create-record tests to verify GREEN**

Run: `node --test tests/server-import-create-records.test.js`

Expected: PASS; create and overwrite update the index, dry-run leaves it absent, and an index-write failure is explicit with the already-created record ID.

- [ ] **Step 5: Commit topic registration**

```bash
git add src/server.js tests/server-import-create-records.test.js
git commit -m "feat: 新增飞书记录后登记具体主题"
```

### Task 7: Make `skill_upload schedule` check first and carry seed-bound confirmation

**Files:**
- Modify: `scripts/skill_upload.py`
- Modify: `tests/server-import-create-records.test.js`

- [ ] **Step 1: Add a failing Python subprocess contract test**

Extend the existing embedded Python test so `skill_upload.zhifa_post` records route calls. Use a plan with `seed`, `currentItems`, and no confirmation. Return a conflict from `/api/import/topic-spacing-check`; assert `cmd_schedule` exits before `/api/import/schedule`, prints the conflict summary, and leaves no schedule output. Then add a plan with matching:

```json
{
  "confirmation": {
    "inputFingerprint": "server-fingerprint",
    "decision": "auto_space",
    "conflictIds": ["conflict-a"]
  }
}
```

and assert call order is exactly `['/api/import/topic-spacing-check', '/api/import/schedule']`. Return a different fingerprint from check and assert the old confirmation is rejected locally before the schedule call.

- [ ] **Step 2: Run the Python contract test to verify RED**

Run: `node --test tests/server-import-create-records.test.js`

Expected: FAIL because `cmd_schedule` currently calls only `/api/import/schedule`.

- [ ] **Step 3: Normalize the default window and mandatory seed**

In `normalize_schedule_plan_payload`, require a non-empty `seed`. When the human phrase field is `timeHint: "早上9点左右"` and no explicit window exists, normalize to:

```python
payload["timeWindows"] = {
    "regular": [{"date": payload["date"], "start": "08:00", "end": "12:00"}],
    "special": [],
}
```

If neither an explicit window nor the recognized default phrase exists, raise `ValueError("缺少明确时间窗；“早上9点左右”仅可解释为 08:00—12:00")`. Never silently move a note to another date.

- [ ] **Step 4: Call the check endpoint before schedule and reject stale confirmation**

In `cmd_schedule`, after constructing `request_payload`, add:

```python
check_result = zhifa_post("/api/import/topic-spacing-check", request_payload)
server_fingerprint = str(check_result.get("inputFingerprint") or "")
conflicts = check_result.get("conflicts") if isinstance(check_result.get("conflicts"), list) else []
confirmation = request_payload.get("confirmation") if isinstance(request_payload.get("confirmation"), dict) else None

if conflicts and confirmation is None:
    print(json.dumps({
        "requiresConfirmation": True,
        "inputFingerprint": server_fingerprint,
        "conflicts": conflicts,
        "choices": ["auto_space", "adjust_window", "allow_conflicts"],
    }, ensure_ascii=False, indent=2))
    print("检测到同店铺组跨账号相同主题。请在开始排期前选择自动错开、调整时间窗，或明确放行本批指定冲突。", file=sys.stderr)
    sys.exit(2)

if conflicts and str(confirmation.get("inputFingerprint") or "") != server_fingerprint:
    print("排期输入已变化，原同主题确认失效，请重新检查后再排期。", file=sys.stderr)
    sys.exit(2)

request_payload["confirmation"] = confirmation
result = zhifa_post("/api/import/schedule", request_payload)
```

Remove the old optional `minSameAccountIntervalMinutes` copying. The server response always carries `constraints.minSameAccountIntervalMinutes = 361`, and `cmd_build_records` must preserve that value unchanged.

- [ ] **Step 5: Run Python and server tests to verify GREEN**

Run: `node --test tests/server-import-create-records.test.js`

Expected: PASS; conflict without decision stops before scheduling, fresh decision performs check then schedule, and stale input fingerprint stops locally.

- [ ] **Step 6: Run Python syntax verification**

Run: `python3 -m py_compile scripts/skill_upload.py`

Expected: exit 0 with no output.

- [ ] **Step 7: Commit upload-client flow**

```bash
git add scripts/skill_upload.py tests/server-import-create-records.test.js
git commit -m "feat: 上传排期前强制确认同主题冲突"
```

### Task 8: Document, verify, independently review, and close the roadmap

**Files:**
- Modify: `skills/zhifa-upload/SKILL.md`
- Modify: `skills/zhifa-pipeline/SKILL.md`
- Modify: `README.md`
- Modify: `docs/roadmap.md`

- [ ] **Step 1: Update `zhifa-upload` before-schedule procedure**

Add a mandatory section immediately before its schedule command:

```markdown
### 排期前同主题确认（必须先做）

1. 计划 JSON 必须包含固定 `seed`、明确时间窗、`currentItems` 的具体主题／账号／店铺组。只说「早上 9 点左右」时写成 08:00—12:00。
2. 第一次运行 `schedule` 只要服务端返回同店铺组跨账号相同具体主题，就必须在生成排期前一次性向用户展示全部冲突并停止。
3. 用户只能选择：`auto_space` 自动错开、修改时间窗后重查、`allow_conflicts` 明确放行本批指定冲突。确认只绑定服务端返回的 `inputFingerprint` 和 `conflictIds`；账号、主题、日期、时间窗、店铺组或 seed 变化后必须重新询问。
4. `allow_conflicts` 只放行跨账号同主题；同一账号相邻笔记严格大于 6 小时，分钟精度最小 361 分钟，任何选择都不能绕过。
5. 时间容量不足、全批分钟重复、主题索引／飞书／发布历史读取失败时停止，不少排、不静默改日期、不压缩间隔。
```

- [ ] **Step 2: Make `zhifa-pipeline` reuse the same scheduling entry**

Add this exact boundary to the pipeline Skill at its scheduling step:

```markdown
排期只能调用 `zhifa-upload` 的 `scripts/skill_upload.py schedule` 入口；不得在 pipeline 内另算随机时间、另存主题例外或绕过排期前确认。旧记录不回填主题、不按标题推断，只处理 `topic-index.json` 中上线后新增的记录。
```

- [ ] **Step 3: Add concise user documentation to `README.md`**

Add a section covering:

```markdown
## 排期安全规则

- 同一账号任意相邻笔记必须严格大于 6 小时；系统按分钟排期，因此最小合法间隔为 361 分钟，这条规则不能放行。
- 同一店铺组跨账号出现相同具体主题时，知发会在生成排期前集中询问：自动错开、调整时间窗，或仅放行本批指定冲突。同系列的不同具体主题不算冲突。
- 批量排期把时间窗均分成小段，每段最多一篇，再用固定 seed 在段内选择分钟；同一批不会出现相同分钟，输入与 seed 不变可复算。
- 「早上 9 点左右」默认按 08:00—12:00；显式时间窗优先。
- 规则只处理功能上线后的新增记录。旧记录不回填、不推断、不迁移。
- 时间容量不足或主题索引、飞书记录、发布历史读取失败时，排期会明确停止，不会少排、改日期或压缩间隔。
```

- [ ] **Step 4: Verify documentation has no conflicting legacy wording**

Run:

```bash
rg -n "360|6小时|6 小时|排期前|topic-index|同主题|早上 9 点|08:00" README.md skills/zhifa-upload/SKILL.md skills/zhifa-pipeline/SKILL.md
```

Expected: all active instructions say 361 minutes for the hard boundary; 360 may appear only in an explicitly labeled historical section and must not be presented as current behavior.

- [ ] **Step 5: Commit workflow documentation**

```bash
git add README.md skills/zhifa-upload/SKILL.md skills/zhifa-pipeline/SKILL.md
git commit -m "docs: 固化同主题确认与分散排期流程"
```

- [ ] **Step 6: Run the complete targeted suite**

Run:

```bash
node --test tests/topic-spacing-guard.test.js tests/scheduler-allocator.test.js tests/server-import-create-records.test.js
```

Expected: all targeted tests PASS. Preserve the earlier per-task RED command outputs and these GREEN results in the implementation report; a GREEN-only report does not replace RED evidence.

- [ ] **Step 7: Run syntax checks for both runtimes**

Run:

```bash
npm run check:syntax
node --check src/topic-spacing-guard.js
python3 -m py_compile scripts/skill_upload.py
```

Expected: all three commands exit 0; the explicit `node --check` covers the new module without expanding the approved file scope to `package.json`.

- [ ] **Step 8: Run full tests and isolate the known baseline failure honestly**

Run:

```bash
node --test tests/*.test.js
```

Expected: all feature tests pass. The previously recorded baseline is 53 tests with 52 PASS and one existing failure in `tests/account-mapping.test.js`; if that same assertion remains the only failure, report it as pre-existing and out of scope. Any new failure or a changed failure signature blocks completion.

- [ ] **Step 9: Run a no-publish milestone probe**

Start the local server against temporary config/data and stubbed Feishu methods through the integration test only; do not call real upload, create real Feishu records, submit to 蚁小二, or publish publicly. Verify these observable milestones through HTTP tests:

```text
topic-index missing -> empty v1 context
topic-index corrupt -> schedule check 500
same topic across account -> check 200 + requiresConfirmation=true
schedule without confirmation -> 409
schedule with unchanged input confirmation -> 200
same-account 360 minutes -> 400
same-account 361 minutes -> 200
same seed and input -> identical schedule
insufficient unique minutes -> 400
```

Expected: every line is observed in automated HTTP or allocator output; no real external write occurs.

- [ ] **Step 10: Request independent cold-eye review**

Use an independent reviewer that did not implement the feature. Give it the approved spec, implementation diff, targeted/full test outputs, and ask it to inspect specifically:

```text
P0: any path that treats topic-index corruption/read failure as empty
P0: any way to bypass 361-minute same-account spacing
P0: any stale confirmation accepted after account/topic/date/window/storeGroup/seed changes
P1: old non-indexed records accidentally included
P1: server trusting client-provided existing reservations
P1: partial scheduling, duplicate minute, silent date movement, or non-repeatable seed
P1: created Feishu record reported as ordinary success after topic-index write failure
P1: real publisher/scheduler state machine changed outside approved scope
```

Expected: review returns no open P0/P1. Fix any P0/P1 with a new failing regression test, rerun targeted and full verification, and have the independent reviewer re-check the fix.

- [ ] **Step 11: Update roadmap completion evidence only after verification**

Run `git rev-parse --short HEAD` after the final implementation commit and copy its exact output. In `docs/roadmap.md`, change the current phase and 2026-07-15 entry from 🚧 to ✅ only after that hash and all verification outputs exist. Set the top five fields to the following concrete facts, substituting only the exact measured counts, review conclusion, date, and hash from Step 6 through Step 10:

```markdown
- **当前阶段**：✅ 同主题间隔与批量分散排期已完成
- **一句话现状**：上线后新增记录已纳入主题索引、排期前确认、同账号 361 分钟硬约束和固定 seed 分层随机；旧记录保持不处理。
- **阻塞**：无；`tests/account-mapping.test.js` 的既有失败与本专项无关，失败签名与施工前基线一致。
- **最近验证**：2026-07-15，针对性测试、Node/Python 语法检查、全量测试和无发布里程碑探针均已按本计划执行；独立冷眼审查无遗留 P0/P1。测试数量必须取命令实际输出，不沿用施工前基线猜测。
- **commit hash**：使用本步骤前 `git rev-parse --short HEAD` 的实际输出，并确认该提交包含全部实现文件。
```

In the专项 entry, append the same real hash and one-sentence verification evidence. Do not mark ✅ while either value is absent.

- [ ] **Step 12: Commit roadmap evidence**

```bash
git add docs/roadmap.md
git commit -m "docs: 记录同主题分散排期验收证据"
```

- [ ] **Step 13: Perform final diff and secret/path scan before handoff**

Run:

```bash
git diff --check main...HEAD
git status --short
git diff --name-only main...HEAD
git diff main...HEAD | rg -n "/Users/xili|sk-|Bearer |cli_|password|token="
```

Expected: `git diff --check` exits 0; only approved files are listed; no project-local worktree artifacts or unrelated untracked paths are staged; the sensitive scan has no real credential or local absolute path. The implementation branch is ready for the main agent to merge and push after applying `superpowers:finishing-a-development-branch`.
