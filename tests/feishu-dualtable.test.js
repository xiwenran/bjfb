// 双表路由 + 字段白名单单元测试。
// mock 掉 axios（feishu.js 顶部 `const axios = require('axios').create(...)` 是模块级单例，
// 必须在 require('../src/feishu.js') 之前把 axios 模块换成可控 mock，且该 mock 实例
// 在整个测试文件生命周期内只创建一次 —— 与真实模块的单例语义一致）。
// node --test 默认每个测试文件独立子进程运行，因此这里替换 require.cache 不会影响其他测试文件。
const test = require('node:test');
const assert = require('node:assert/strict');

const axiosResolvedPath = require.resolve('axios');

const calls = []; // { method, url, body }（含 tenant_access_token 调用）
function recordCall(method, url, body) {
  calls.push({ method, url, body });
}
// 业务调用视角的 calls：过滤掉底层自动触发的 token 获取请求，
// 断言路由目标时只关心真正的业务请求打到了哪张表。
function dataCalls() {
  return calls.filter(c => !c.url.includes('/auth/v3/tenant_access_token/internal'));
}

// form-data 库的 FormData 实例把已 append 的字段存在 _streams 数组里，其中既有
// Buffer/string（字段头+值），也有非纯文本项（比如文件流本身）。只拼接 Buffer/string
// 项即可还原出 parent_node 等纯文本字段前面的 multipart 片段，不需要真的做 multipart 解析。
function extractFormField(form, fieldName) {
  const streams = form._streams || [];
  const joined = streams
    .filter(s => Buffer.isBuffer(s) || typeof s === 'string')
    .map(s => (Buffer.isBuffer(s) ? s.toString('utf8') : s))
    .join('');
  // 值只用于测试里的 appToken（纯字母数字下划线），直接限定字符集，
  // 避免跨 chunk 拼接时把紧随其后的 multipart 边界线（--boundary）一并捕获。
  const re = new RegExp(`name="${fieldName}"\\r\\n\\r\\n([A-Za-z0-9_]*)`);
  const m = joined.match(re);
  return m ? m[1] : null;
}

function fakeResponseFor(method, url, body) {
  if (url.includes('/auth/v3/tenant_access_token/internal')) {
    return { data: { tenant_access_token: 'fake_token', expire: 7200 } };
  }
  if (url.includes('/records/search')) {
    return { data: { data: { items: [], has_more: false } } };
  }
  if (url.includes('/medias/upload_all')) {
    return { data: { code: 0, data: { file_token: `ft_${extractFormField(body, 'parent_node')}` } } };
  }
  if (url.includes('/medias/upload_prepare')) {
    return { data: { code: 0, data: { upload_id: 'up_1' } } };
  }
  if (url.includes('/medias/upload_part')) {
    return { data: { code: 0 } };
  }
  if (url.includes('/medias/upload_finish')) {
    return { data: { code: 0, data: { file_token: 'ft_large' } } };
  }
  if (url.endsWith('/fields') && method === 'get') {
    return { data: { data: { items: [], has_more: false } } };
  }
  if (url.endsWith('/fields') && method === 'post') {
    return { data: { code: 0, data: { field: { field_name: 'x' } } } };
  }
  if (/\/records$/.test(url) && method === 'post') {
    return { data: { code: 0, data: { record: { record_id: 'rec_new' } } } };
  }
  if (/\/records\/[^/]+$/.test(url) && method === 'put') {
    return { data: { code: 0 } };
  }
  if (/\/records\/[^/]+$/.test(url) && method === 'get') {
    return { data: { data: { record: { record_id: 'rec_x', fields: {} } } } };
  }
  throw new Error(`fakeResponseFor: 未覆盖的 URL: ${method} ${url}`);
}

// 单例：与真实 `const axios = require('axios').create(...)` 的模块级单例语义一致
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
const { normalizePlatformKey, filterFieldsForPlatform, COMMON_FEISHU_FIELDS, PLATFORM_ONLY_FEISHU_FIELDS } = FeishuClient;

function makeDualClient() {
  return new FeishuClient({
    appId: 'app', appSecret: 'secret',
    // legacy 字段刻意留空，验证双表模式下不会误用
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

test.beforeEach(() => { calls.length = 0; });

// ── normalizePlatformKey ────────────────────────────────────────────────
test('normalizePlatformKey：中英文平台名都能归一化，未知值返回 null', () => {
  assert.equal(normalizePlatformKey('小红书'), 'xiaohongshu');
  assert.equal(normalizePlatformKey('xiaohongshu'), 'xiaohongshu');
  assert.equal(normalizePlatformKey('抖音'), 'douyin');
  assert.equal(normalizePlatformKey('douyin'), 'douyin');
  assert.equal(normalizePlatformKey(''), null);
  assert.equal(normalizePlatformKey(undefined), null);
  assert.equal(normalizePlatformKey('快手'), null);
});

// ── 路由：getRecords 命中正确的 app/table ──────────────────────────────
test('双表模式：getRecords(filter, "小红书") 打到小红书表，"抖音" 打到抖音表', async () => {
  const client = makeDualClient();
  await client.getRecords({}, '小红书');
  assert.equal(dataCalls().length, 1);
  assert.match(dataCalls()[0].url, /\/apps\/XHS_APP\/tables\/XHS_TABLE\/records\/search/);

  calls.length = 0;
  await client.getRecords({}, '抖音');
  assert.equal(dataCalls().length, 1);
  assert.match(dataCalls()[0].url, /\/apps\/DY_APP\/tables\/DY_TABLE\/records\/search/);
});

test('双表模式：不传 platform 时回退 legacy 单表字段（此时为空，暴露未路由调用）', async () => {
  const client = makeDualClient();
  await client.getRecords({});
  assert.match(dataCalls()[0].url, /\/apps\/\/tables\//); // appToken/tableId 均为空，证明没有误用某个平台的表
});

test('旧版单表模式（未配置 tables）：不传 platform 与传 platform 结果一致，行为零变化', async () => {
  const client = makeLegacyClient();
  await client.getRecords({});
  assert.match(dataCalls()[0].url, /\/apps\/LEGACY_APP\/tables\/LEGACY_TABLE\/records\/search/);

  calls.length = 0;
  await client.getRecords({}, '小红书'); // 即使传了平台，legacy 客户端没有 tables 配置，仍回退单表
  assert.match(dataCalls()[0].url, /\/apps\/LEGACY_APP\/tables\/LEGACY_TABLE\/records\/search/);
});

// ── 字段白名单过滤 ──────────────────────────────────────────────────────
test('filterFieldsForPlatform：小红书表只保留公共字段+小红书专属字段，丢弃抖音专属/残留字段', () => {
  const fields = {
    '标题': 'T', '正文': 'B', '小红书账号': 'acct', '小红书发布渠道': '蚁小二',
    '抖音账号': 'dy_acct', '抖音发布状态': '待发布', '抖音发布人': '张三',
  };
  const { fields: out, dropped } = filterFieldsForPlatform(fields, 'xiaohongshu');
  assert.deepEqual(Object.keys(out).sort(), ['小红书发布渠道', '小红书账号', '标题', '正文'].sort());
  assert.deepEqual(dropped.sort(), ['抖音账号', '抖音发布人', '抖音发布状态'].sort());
});

test('filterFieldsForPlatform：抖音表只保留公共字段+抖音专属字段，丢弃小红书专属/残留字段', () => {
  const fields = {
    '标题': 'T', '抖音账号': 'dy', '抖音发布状态': '待发布',
    '小红书账号': 'xhs', '小红书发布渠道': '蚁小二', '小红书发布状态': '待发布',
  };
  const { fields: out, dropped } = filterFieldsForPlatform(fields, 'douyin');
  assert.deepEqual(Object.keys(out).sort(), ['抖音发布状态', '抖音账号', '标题'].sort());
  assert.deepEqual(dropped.sort(), ['小红书账号', '小红书发布状态', '小红书发布渠道'].sort());
});

test('filterFieldsForPlatform：platformKey 为 null（legacy）时原样透传，不丢字段', () => {
  const fields = { '标题': 'T', '小红书账号': 'xhs', '抖音账号': 'dy', '随便什么字段': 1 };
  const { fields: out, dropped } = filterFieldsForPlatform(fields, null);
  assert.deepEqual(out, fields);
  assert.deepEqual(dropped, []);
});

test('COMMON_FEISHU_FIELDS 与 PLATFORM_ONLY_FEISHU_FIELDS 不相交（防止误配置导致的字段冲突）', () => {
  const commonSet = new Set(COMMON_FEISHU_FIELDS);
  for (const key of Object.keys(PLATFORM_ONLY_FEISHU_FIELDS)) {
    for (const f of PLATFORM_ONLY_FEISHU_FIELDS[key]) {
      assert.ok(!commonSet.has(f), `字段 "${f}" 同时出现在 COMMON 和 ${key} 专属列表`);
    }
  }
});

// ── createRecord / updateRecord 路由 + 过滤 ──────────────────────────────
test('createRecord：双表模式下按平台路由到正确的表，且过滤残留字段', async () => {
  const client = makeDualClient();
  const fields = { '标题': 'T', '小红书账号': 'xhs', '抖音发布人': '残留字段不该出现' };
  await client.createRecord(fields, '小红书');
  assert.equal(dataCalls().length, 1);
  assert.match(dataCalls()[0].url, /\/apps\/XHS_APP\/tables\/XHS_TABLE\/records$/);
  assert.deepEqual(dataCalls()[0].body, { fields: { '标题': 'T', '小红书账号': 'xhs' } });
});

test('createRecord：抖音记录不应包含小红书专属字段', async () => {
  const client = makeDualClient();
  const fields = { '标题': 'T', '抖音账号': 'dy', '小红书发布渠道': '不该写入抖音表' };
  await client.createRecord(fields, '抖音');
  assert.match(dataCalls()[0].url, /\/apps\/DY_APP\/tables\/DY_TABLE\/records$/);
  assert.deepEqual(dataCalls()[0].body, { fields: { '标题': 'T', '抖音账号': 'dy' } });
});

test('createRecord：旧版单表模式下字段原样透传，逐字节与改造前一致', async () => {
  const client = makeLegacyClient();
  const fields = { '标题': 'T', '小红书账号': 'xhs', '抖音账号': 'dy', '随便字段': 1 };
  await client.createRecord(fields);
  assert.match(dataCalls()[0].url, /\/apps\/LEGACY_APP\/tables\/LEGACY_TABLE\/records$/);
  assert.deepEqual(dataCalls()[0].body, { fields });
});

test('updateRecord：全部字段被过滤为空时不发起网络请求（视为无操作成功）', async () => {
  const client = makeDualClient();
  // markPublished 场景：发布状态字段不在任何一张新表的白名单里
  await client.updateRecord('rec_1', { '发布状态': '已发布' }, '小红书');
  assert.equal(dataCalls().length, 0, '不应该发起 PUT 请求');
});

test('markPlatformStatus：按 platform 参数路由到对应表', async () => {
  const client = makeDualClient();
  await client.markPlatformStatus('rec_1', '小红书', '待发布');
  assert.equal(dataCalls().length, 1);
  assert.match(dataCalls()[0].url, /\/apps\/XHS_APP\/tables\/XHS_TABLE\/records\/rec_1$/);

  calls.length = 0;
  await client.markPlatformStatus('rec_2', '抖音', '待发布');
  assert.match(dataCalls()[0].url, /\/apps\/DY_APP\/tables\/DY_TABLE\/records\/rec_2$/);
});

// ── uploadLocalImagesToFeishu：parent_node 必须匹配目标表所在 app ────────
test('uploadLocalImagesToFeishu：双表模式下按 options.platform 选择正确的 parent_node appToken', async () => {
  const client = makeDualClient();
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmpFile = path.join(os.tmpdir(), `zhifa-dualtable-test-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'hello world');

  const uploadedXhs = await client.uploadLocalImagesToFeishu([tmpFile], { platform: '小红书', useRecovery: false });
  assert.equal(uploadedXhs[0].fileToken, 'ft_XHS_APP');

  const uploadedDy = await client.uploadLocalImagesToFeishu([tmpFile], { platform: '抖音', useRecovery: false });
  assert.equal(uploadedDy[0].fileToken, 'ft_DY_APP');

  fs.unlinkSync(tmpFile);
});

test('uploadLocalImagesToFeishu：旧版单表模式下 parent_node 用回退 appToken', async () => {
  const client = makeLegacyClient();
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmpFile = path.join(os.tmpdir(), `zhifa-dualtable-test-legacy-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'hello world');

  const uploaded = await client.uploadLocalImagesToFeishu([tmpFile], { useRecovery: false });
  assert.equal(uploaded[0].fileToken, 'ft_LEGACY_APP');

  fs.unlinkSync(tmpFile);
});

// ── config 解析：isFeishuConfigured 新旧两种配置 ─────────────────────────
test('isFeishuConfigured：双表模式下两张表都配好才算 configured', () => {
  const os = require('os');
  const path = require('path');
  process.env.NOTE_PUBLISHER_CONFIG_DIR = path.join(os.tmpdir(), `zhifa-cfg-test-${Date.now()}`);
  process.env.NOTE_PUBLISHER_DATA_DIR = path.join(os.tmpdir(), `zhifa-data-test-${Date.now()}`);
  delete require.cache[require.resolve('../src/config-store.js')];
  const { isFeishuConfigured } = require('../src/config-store.js');

  // 双表都配好 → true
  assert.equal(isFeishuConfigured({
    feishu: {
      appId: 'a', appSecret: 's',
      tables: {
        xiaohongshu: { appToken: 'x1', tableId: 't1' },
        douyin: { appToken: 'x2', tableId: 't2' },
      },
    },
  }), true);

  // 只配了一张表，且 legacy 单表也没配 → false
  assert.equal(isFeishuConfigured({
    feishu: {
      appId: 'a', appSecret: 's',
      tables: {
        xiaohongshu: { appToken: 'x1', tableId: 't1' },
        douyin: { appToken: '', tableId: '' },
      },
    },
  }), false);

  // 只配了一张表，但 legacy 单表也配好了 → 回退单表校验 → true
  assert.equal(isFeishuConfigured({
    feishu: {
      appId: 'a', appSecret: 's', appToken: 'legacy_app', tableId: 'legacy_table',
      tables: {
        xiaohongshu: { appToken: 'x1', tableId: 't1' },
        douyin: { appToken: '', tableId: '' },
      },
    },
  }), true);

  // 完全没配 tables，legacy 单表配好 → true（旧行为不变）
  assert.equal(isFeishuConfigured({
    feishu: { appId: 'a', appSecret: 's', appToken: 'legacy_app', tableId: 'legacy_table' },
  }), true);

  // 什么都没配 → false
  assert.equal(isFeishuConfigured({ feishu: {} }), false);
});
