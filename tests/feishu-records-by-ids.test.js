// getRecordsByIds 单元测试。
// 背景：skill_upload.py 的 verify 子命令原来靠 /api/records?status=all 拉全表按 recordId
// 比对，表大了必超时还会拖崩知发。改成只按本次 recordId 批量查询（飞书 records/batch_get），
// 这里验证：①>100 条自动分两批且请求体正确 ②absent 正确汇总 ③飞书 code≠0 时抛错
// ④双表模式 platform 解析到正确的表。
//
// mock 掉 axios 的方式与 tests/feishu-dualtable.test.js 保持一致（模块级单例必须在
// require('../src/feishu.js') 之前替换）。
const test = require('node:test');
const assert = require('node:assert/strict');

const axiosResolvedPath = require.resolve('axios');

const calls = []; // { method, url, body }
function recordCall(method, url, body) {
  calls.push({ method, url, body });
}
function dataCalls() {
  return calls.filter(c => !c.url.includes('/auth/v3/tenant_access_token/internal'));
}

// 模拟飞书侧"存在的记录"集合：record_id → 是否存在。测试用例按需往里塞。
let existingRecordIds = new Set();
// 下一次响应要模拟的错误 code（0 = 正常）
let nextErrorCode = 0;

function fakeResponseFor(method, url, body) {
  if (url.includes('/auth/v3/tenant_access_token/internal')) {
    return { data: { tenant_access_token: 'fake_token', expire: 7200 } };
  }
  if (url.includes('/records/batch_get') && method === 'post') {
    if (nextErrorCode !== 0) {
      return { data: { code: nextErrorCode, msg: 'mock 飞书错误' } };
    }
    const requestedIds = Array.isArray(body.record_ids) ? body.record_ids : [];
    const records = requestedIds
      .filter(id => existingRecordIds.has(id))
      .map(id => ({ record_id: id, fields: { '标题': `title-${id}` } }));
    return { data: { code: 0, data: { records } } };
  }
  throw new Error(`fakeResponseFor: 未覆盖的 URL: ${method} ${url}`);
}

const mockAxiosSingleton = {
  post: async (url, body) => { recordCall('post', url, body); return fakeResponseFor('post', url, body); },
  get: async (url) => { recordCall('get', url); return fakeResponseFor('get', url); },
  put: async (url, body) => { recordCall('put', url, body); return fakeResponseFor('put', url, body); },
};

require.cache[axiosResolvedPath] = {
  id: axiosResolvedPath,
  filename: axiosResolvedPath,
  loaded: true,
  exports: { create: () => mockAxiosSingleton },
};

const FeishuClient = require('../src/feishu.js');

function makeDualClient() {
  return new FeishuClient({
    appId: 'app', appSecret: 'secret',
    appToken: '', tableId: '',
    tables: {
      xiaohongshu: { appToken: 'XHS_APP', tableId: 'XHS_TABLE' },
      douyin: { appToken: 'DY_APP', tableId: 'DY_TABLE' },
    },
  });
}

function makeLegacyClient() {
  return new FeishuClient({
    appId: 'app', appSecret: 'secret',
    appToken: 'LEGACY_APP', tableId: 'LEGACY_TABLE',
  });
}

test.beforeEach(() => {
  calls.length = 0;
  existingRecordIds = new Set();
  nextErrorCode = 0;
});

test('getRecordsByIds：空数组直接返回空结果，不发请求', async () => {
  const client = makeLegacyClient();
  const result = await client.getRecordsByIds([], undefined);
  assert.deepEqual(result, { records: [], absent: [] });
  assert.equal(dataCalls().length, 0);
});

test('getRecordsByIds：>100 条自动分两批，且每批请求体 record_ids 数量与内容正确', async () => {
  const client = makeLegacyClient();
  const ids = Array.from({ length: 150 }, (_, i) => `rec_${i}`);
  existingRecordIds = new Set(ids); // 全部存在

  const result = await client.getRecordsByIds(ids, undefined);

  assert.equal(dataCalls().length, 2, '150 条应分两批（100+50）');
  assert.equal(dataCalls()[0].body.record_ids.length, 100);
  assert.equal(dataCalls()[1].body.record_ids.length, 50);
  assert.deepEqual(dataCalls()[0].body.record_ids, ids.slice(0, 100));
  assert.deepEqual(dataCalls()[1].body.record_ids, ids.slice(100, 150));
  assert.equal(result.records.length, 150);
  assert.deepEqual(result.absent, []);
});

test('getRecordsByIds：absent 正确汇总缺失的 recordId（跨批次）', async () => {
  const client = makeLegacyClient();
  const ids = Array.from({ length: 120 }, (_, i) => `rec_${i}`);
  // 只让第一批的一部分、第二批的一部分存在，制造跨批次缺失
  existingRecordIds = new Set([...ids.slice(0, 50), ...ids.slice(100, 110)]);

  const result = await client.getRecordsByIds(ids, undefined);

  const expectedAbsent = [...ids.slice(50, 100), ...ids.slice(110, 120)].sort();
  assert.deepEqual(result.absent.sort(), expectedAbsent);
  assert.equal(result.records.length, 60);
});

test('getRecordsByIds：去重后再查询，重复 id 不会重复计入批次', async () => {
  const client = makeLegacyClient();
  existingRecordIds = new Set(['rec_a', 'rec_b']);
  const result = await client.getRecordsByIds(['rec_a', 'rec_a', 'rec_b'], undefined);
  assert.equal(dataCalls()[0].body.record_ids.length, 2);
  assert.equal(result.records.length, 2);
});

test('getRecordsByIds：飞书返回 code≠0 时抛错，不返回空结果冒充成功', async () => {
  const client = makeLegacyClient();
  nextErrorCode = 1254045;
  await assert.rejects(
    () => client.getRecordsByIds(['rec_1'], undefined),
    (err) => {
      assert.match(err.message, /飞书 getRecordsByIds 失败/);
      assert.equal(err.feishuCode, 1254045);
      return true;
    }
  );
});

test('getRecordsByIds：双表模式下 platform 解析到正确的表', async () => {
  const client = makeDualClient();
  existingRecordIds = new Set(['rec_x']);

  await client.getRecordsByIds(['rec_x'], '小红书');
  assert.equal(dataCalls().length, 1);
  assert.match(dataCalls()[0].url, /\/apps\/XHS_APP\/tables\/XHS_TABLE\/records\/batch_get/);

  calls.length = 0;
  await client.getRecordsByIds(['rec_x'], '抖音');
  assert.equal(dataCalls().length, 1);
  assert.match(dataCalls()[0].url, /\/apps\/DY_APP\/tables\/DY_TABLE\/records\/batch_get/);
});

test('getRecordsByIds：旧版单表模式下不传 platform，打到 legacy 表', async () => {
  const client = makeLegacyClient();
  existingRecordIds = new Set(['rec_x']);
  await client.getRecordsByIds(['rec_x']);
  assert.match(dataCalls()[0].url, /\/apps\/LEGACY_APP\/tables\/LEGACY_TABLE\/records\/batch_get/);
});
