// 双表模式断点续传缓存的 scope 隔离单元测试。
// 背景(真实上传验收 2026-07-26 发现的 bug):同一张图同时发布到小红书表和抖音表时,
// makeRecoveryKey 原本不含平台/appToken 维度,小红书上传得到的 fileToken 被抖音表复用,
// 飞书写入时报错 code=1254303 "The attachment does not belong to this bitable"。
// 修复:makeRecoveryKey(imagePath, scope) 把 uploadAppToken 拼进 key 前缀。
// 本文件验证:(1) 同路径不同 scope 生成不同 key;(2) 同路径同 scope 生成相同 key;
// (3) clearImportRecoveryFor 能把同一张图在两个不同 scope 下的缓存条目都清掉。
//
// mock 掉 axios 的方式与 tests/feishu-dualtable.test.js 保持一致(模块级单例必须在
// require('../src/feishu.js') 之前替换)。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const axiosResolvedPath = require.resolve('axios');

function fakeResponseFor(method, url, body) {
  if (url.includes('/auth/v3/tenant_access_token/internal')) {
    return { data: { tenant_access_token: 'fake_token', expire: 7200 } };
  }
  if (url.includes('/medias/upload_all')) {
    // parent_node（appToken）原样回填进 file_token，方便断言到底打到了哪张表的 app
    const streams = (body._streams || [])
      .filter((s) => Buffer.isBuffer(s) || typeof s === 'string')
      .map((s) => (Buffer.isBuffer(s) ? s.toString('utf8') : s))
      .join('');
    const m = streams.match(/name="parent_node"\r\n\r\n([A-Za-z0-9_]*)/);
    const parentNode = m ? m[1] : 'unknown';
    return { data: { code: 0, data: { file_token: `ft_${parentNode}` } } };
  }
  throw new Error(`fakeResponseFor: 未覆盖的 URL: ${method} ${url}`);
}

let uploadCallCount = 0;
const mockAxiosSingleton = {
  post: async (url, body) => {
    if (url.includes('/medias/upload_all')) uploadCallCount += 1;
    return fakeResponseFor('post', url, body);
  },
  get: async (url) => fakeResponseFor('get', url),
  put: async (url, body) => fakeResponseFor('put', url, body),
};

require.cache[axiosResolvedPath] = {
  id: axiosResolvedPath,
  filename: axiosResolvedPath,
  loaded: true,
  exports: { create: () => mockAxiosSingleton },
};

// import-recovery.json 落到独立临时目录,不污染真实用户数据/其他测试文件
const tmpDataDir = path.join(os.tmpdir(), `zhifa-recovery-scope-test-${Date.now()}`);
process.env.NOTE_PUBLISHER_CONFIG_DIR = path.join(tmpDataDir, 'config');
process.env.NOTE_PUBLISHER_DATA_DIR = path.join(tmpDataDir, 'data');

const FeishuClient = require('../src/feishu.js');
const { makeRecoveryKey } = FeishuClient;
const { readImportRecovery } = require('../src/config-store.js');

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

// ── makeRecoveryKey：scope 隔离的最小单元测试 ──────────────────────────
test('makeRecoveryKey：同一 imagePath 配不同 scope 生成不同 key', () => {
  const tmpFile = path.join(os.tmpdir(), `zhifa-recovery-key-test-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'hello');
  try {
    const keyXhs = makeRecoveryKey(tmpFile, 'XHS_APP');
    const keyDy = makeRecoveryKey(tmpFile, 'DY_APP');
    assert.notEqual(keyXhs, keyDy, '不同 scope 必须产生不同的 key，否则会跨表复用 fileToken');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('makeRecoveryKey：同一 imagePath 配相同 scope 生成相同 key（可复用缓存）', () => {
  const tmpFile = path.join(os.tmpdir(), `zhifa-recovery-key-test-2-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'hello');
  try {
    const key1 = makeRecoveryKey(tmpFile, 'XHS_APP');
    const key2 = makeRecoveryKey(tmpFile, 'XHS_APP');
    assert.equal(key1, key2, '同一 scope 下多次调用应生成一致的 key，否则断点续传永远不会命中缓存');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('makeRecoveryKey：未传 scope 时行为退化为旧版（scope 为空前缀），不同路径仍不同 key', () => {
  const tmpFile = path.join(os.tmpdir(), `zhifa-recovery-key-test-3-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'hello');
  try {
    const keyNoScope = makeRecoveryKey(tmpFile);
    assert.ok(keyNoScope.startsWith('|'), '未传 scope 时前缀应为空字符串');
    assert.ok(keyNoScope.includes(tmpFile));
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// ── 端到端：双表模式上传 + 断点续传缓存 + 清理 ──────────────────────────
test('uploadLocalImagesToFeishu 双表模式：同一张图分别发小红书/抖音，各自拿到归属正确的 fileToken 且互不覆盖', async () => {
  const client = makeDualClient();
  const tmpFile = path.join(os.tmpdir(), `zhifa-recovery-e2e-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'shared image content');

  try {
    uploadCallCount = 0;

    const xhsResult = await client.uploadLocalImagesToFeishu([tmpFile], { platform: '小红书' });
    assert.equal(xhsResult[0].fileToken, 'ft_XHS_APP');
    assert.equal(uploadCallCount, 1, '小红书首次上传应该真的发起一次网络请求');

    const dyResult = await client.uploadLocalImagesToFeishu([tmpFile], { platform: '抖音' });
    assert.equal(dyResult[0].fileToken, 'ft_DY_APP', 'bug 修复前：这里会因缓存误命中拿到 ft_XHS_APP');
    assert.equal(uploadCallCount, 2, '抖音表是不同 scope，缓存不应命中，必须真的再上传一次');

    // 缓存生效验证：同一平台再传一次同一张图，应命中缓存，不再发起新的网络请求
    const xhsResultAgain = await client.uploadLocalImagesToFeishu([tmpFile], { platform: '小红书' });
    assert.equal(xhsResultAgain[0].fileToken, 'ft_XHS_APP');
    assert.equal(uploadCallCount, 2, '同平台重复上传同一张图应命中断点续传缓存，不应再次发起网络请求');

    // 磁盘上的 recovery 缓存应该同时存在两个 scope 的条目
    const recoveryBeforeClear = readImportRecovery();
    const keys = Object.keys(recoveryBeforeClear);
    assert.ok(keys.some((k) => k.startsWith('XHS_APP|') && k.includes(tmpFile)), '应存在小红书 scope 的缓存条目');
    assert.ok(keys.some((k) => k.startsWith('DY_APP|') && k.includes(tmpFile)), '应存在抖音 scope 的缓存条目');

    // clearImportRecoveryFor 只拿 imagePaths（拿不到 platform/appToken），
    // 必须靠后缀匹配把两个 scope 的条目一起清掉，否则会残留到 24 小时后才自然过期
    client.clearImportRecoveryFor([tmpFile]);
    const recoveryAfterClear = readImportRecovery();
    const remainingKeys = Object.keys(recoveryAfterClear).filter((k) => k.includes(tmpFile));
    assert.deepEqual(remainingKeys, [], 'clearImportRecoveryFor 应该把该图片在所有 scope 下的缓存条目都清掉');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});
