const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const Scheduler = require('./scheduler.js');
const publisher = require('./publisher.js');
const FeishuClient = require('./feishu.js');
const { parseAttachmentSortKey } = require('./feishu.js');
const {
  updateYixiaoerAccountCache,
  autoMapAccountMappings,
  collectMappedAccountIds,
} = require('./account-mapping.js');
const {
  initializeAppStorage,
  saveConfig: persistConfig,
  readLedger,
  saveLedger,
  getRuntimePaths,
  isFeishuConfigured,
  isYixiaoerConfigured,
  readAiWritingCache,
  saveAiWritingCache,
} = require('./config-store.js');
const { generateContent, testConnection } = require('./ai-writer.js');
const { allocateImportSchedule } = require('./scheduler-allocator.js');
const { archiveImportFolders } = require('./archiver.js');

// 版本号 + commit hash 拼接：打包时 predist 脚本会生成 build-info.json，运行时读取拼到版本里
// 开发模式（npm start / npm run desktop）下文件不存在，仅显示 package.json 版本号
let _buildInfo = {};
try { _buildInfo = require('./build-info.json'); } catch (_) { /* dev mode */ }
const APP_VERSION = require('../package.json').version + (_buildInfo.commit ? ` (${_buildInfo.commit})` : '');
const storage = initializeAppStorage();
const runtimePaths = storage.paths;
const storageState = storage.state;
const migrationSources = storage.migrationSources || {};
const config = storage.config;
const DEFAULT_PORT = Number(process.env.NOTE_PUBLISHER_PORT) || 3210;
const DEFAULT_HOST = process.env.NOTE_PUBLISHER_HOST || '127.0.0.1';

const scheduler = new Scheduler(config);
let feishu = new FeishuClient(config.feishu);
let activeServerInfo = null;

function syncConfigObject(nextConfig) {
  for (const key of Object.keys(config)) {
    delete config[key];
  }
  Object.assign(config, nextConfig);
}

function saveConfig() {
  syncConfigObject(persistConfig(config));
}

function refreshFeishuClients() {
  feishu = new FeishuClient(config.feishu);
  scheduler.feishu = new FeishuClient(config.feishu);
}

function getConfigState() {
  return {
    feishuConfigured: isFeishuConfigured(config),
    yixiaoerConfigured: isYixiaoerConfigured(config),
  };
}

function getPublicRuntimePaths() {
  const paths = getRuntimePaths();
  return {
    configDir: paths.configDir,
    configPath: paths.configPath,
    dataDir: paths.dataDir,
    cacheDir: paths.cacheDir,
    logsDir: paths.logsDir,
    ledgerPath: paths.ledgerPath,
  };
}

function cloneConfigForExport() {
  const exported = JSON.parse(JSON.stringify(config));
  delete exported.yixiaoerAccountCache;
  return exported;
}

function buildBackupStamp() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
}

function writeJsonDownload(res, filename, payload) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename=”${filename}”`,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function cloneDataBackupForExport() {
  return {
    type: 'zhifa-data-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    appName: runtimePaths.appName,
    data: {
      config: cloneConfigForExport(),
      ledger: readLedger(),
    },
  };
}

function applyImportedDataBackup(importedBackup) {
  if (!importedBackup || typeof importedBackup !== 'object' || Array.isArray(importedBackup)) {
    throw createConfigError('导入的数据备份格式错误');
  }

  const payload = importedBackup.data;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw createConfigError('导入的数据备份缺少 data 字段');
  }

  const importedConfig = payload.config;
  if (!importedConfig || typeof importedConfig !== 'object' || Array.isArray(importedConfig)) {
    throw createConfigError('导入的数据备份缺少有效的 config');
  }

  const importedLedger = payload.ledger;
  if (importedLedger !== undefined && (!importedLedger || typeof importedLedger !== 'object' || Array.isArray(importedLedger))) {
    throw createConfigError('导入的数据备份中的 ledger 格式错误');
  }

  syncConfigObject(persistConfig(importedConfig));
  saveLedger(importedLedger || {});
  refreshFeishuClients();
  publisher.resetRuntimeState();
  restartSchedulerIfRunning();

  return {
    configState: getConfigState(),
    runtimePaths: getPublicRuntimePaths(),
  };
}

function restartSchedulerIfRunning() {
  if (!scheduler.running) return;
  scheduler.stop();
  scheduler.start();
}

function createConfigError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function ensureFeishuConfigReady() {
  if (isFeishuConfigured(config)) return;
  throw createConfigError('请先在”飞书接入”页完成 App ID、App Secret、App Token、Table ID 配置');
}

function ensureYixiaoerConfigReady() {
  if (isYixiaoerConfigured(config)) return;
  throw createConfigError(`请先在配置文件中补全蚁小二 API Key 和 Team ID：${getRuntimePaths().configPath}`);
}

// 安全：维护用户已扫描的素材根目录白名单（in-memory，进程重启后清空）。
// /api/file 只允许读取这些根目录下的文件，防 DNS rebinding 配合恶意 path 读任意本地图片。
const approvedImportRoots = new Set();
function approveImportRoot(folderPath) {
  try {
    const real = fs.realpathSync(folderPath);
    approvedImportRoots.add(real);
  } catch (_) {}
}
function isPathInApprovedRoots(targetPath) {
  if (!targetPath) return false;
  let real;
  try {
    real = fs.realpathSync(targetPath);
  } catch (_) {
    return false;
  }
  for (const root of approvedImportRoots) {
    if (real === root) return true;
    if (real.startsWith(root + path.sep)) return true;
  }
  return false;
}

// 安全：高权限路由（force-republish 等）必须确认请求来自本机，防御 DNS rebinding 攻击
function isLocalRequest(req) {
  const hostHeader = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (hostHeader && hostHeader !== 'localhost' && hostHeader !== '127.0.0.1' && hostHeader !== '::1') {
    return false;
  }
  const remote = req.socket?.remoteAddress || '';
  // IPv4 回环 / IPv6 回环 / IPv4-mapped IPv6 回环
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

// 启动期飞书字段类型校验所需的字段名
const REQUIRED_SINGLE_SELECT_FIELDS = [
  '小红书账号',
  '小红书发布状态',
  '小红书发布渠道',
  '抖音账号',
  '抖音发布状态',
];

async function getBitBrowserAccountMappings() {
  const records = await feishu.getRecords();
  const parsedRecords = records.map(r => feishu.parseRecord(r));
  const summaryMap = new Map();

  for (const record of parsedRecords) {
    const accountName = (record.xiaohongshuAccount || '').trim();
    if (!accountName) continue;

    if (!summaryMap.has(accountName)) {
      summaryMap.set(accountName, {
        accountName,
        totalRecords: 0,
        bitbrowserRecords: 0,
      });
    }

    const item = summaryMap.get(accountName);
    item.totalRecords += 1;
    if (record.xiaohongshuPublishChannel === '比特浏览器') {
      item.bitbrowserRecords += 1;
    }
  }

  const mappingConfig = config.bitbrowser?.xiaohongshu || {};
  const fieldAccountNames = await feishu.getSingleSelectFieldOptionNames('小红书账号');
  for (const accountName of fieldAccountNames) {
    if (!summaryMap.has(accountName)) {
      summaryMap.set(accountName, {
        accountName,
        totalRecords: 0,
        bitbrowserRecords: 0,
      });
    }
  }
  for (const accountName of Object.keys(mappingConfig)) {
    if (!summaryMap.has(accountName)) {
      summaryMap.set(accountName, {
        accountName,
        totalRecords: 0,
        bitbrowserRecords: 0,
      });
    }
  }

  return Array.from(summaryMap.values())
    .sort((a, b) => a.accountName.localeCompare(b.accountName, 'zh-CN', { numeric: true }))
    .map(item => ({
      ...item,
      browserId: mappingConfig[item.accountName]?.browserId || '',
      configured: !!mappingConfig[item.accountName]?.browserId,
    }));
}

async function syncFeishuSelectFields() {
  const accountNames = [...new Set([
    ...Object.keys(config.accountMapping?.xiaohongshu || {}),
    ...Object.keys(config.bitbrowser?.xiaohongshu || {}),
    ...(await getBitBrowserAccountMappings()).map(item => item.accountName),
  ])].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));

  await feishu.syncSingleSelectFieldOptions('小红书账号', accountNames, { keepExisting: true });
  await feishu.syncSingleSelectFieldOptions('小红书发布渠道', ['蚁小二', '比特浏览器']);

  return {
    accountNames,
    channels: ['蚁小二', '比特浏览器'],
  };
}

function getPrimaryDouyinAccountId() {
  const douyinAccounts = Object.values(config.accountMapping?.douyin || {});
  if (douyinAccounts.length === 0) {
    throw new Error('未配置抖音账号');
  }
  return douyinAccounts[0];
}

function decorateRecord(record) {
  const xiaohongshuPublishChannel = record.xiaohongshuPublishChannel === '比特浏览器' ? '比特浏览器' : '蚁小二';
  return {
    ...record,
    xiaohongshuPublishChannel,
    publishRoutePreview: {
      xiaohongshu: record.xiaohongshuAccount
        ? `${xiaohongshuPublishChannel} · ${record.xiaohongshuAccount}`
        : '',
      douyin: record.douyinAccount ? `蚁小二 · ${record.douyinAccount}` : '',
    },
    previewTags: {
      xiaohongshu: publisher.selectTagsForPlatform('小红书', record.tags, record.title),
      douyin: publisher.selectTagsForPlatform('抖音', record.tags, record.title),
    }
  };
}

function isPendingRecord(record) {
  const xhsPending = !!record.xiaohongshuAccount && record.xiaohongshuStatus === '待发布';
  const dyPending = !!record.douyinAccount && record.douyinStatus === '待发布';
  return xhsPending || dyPending;
}

// SSE clients for real-time log updates
const sseClients = new Set();
scheduler.onLog = (entry) => {
  const data = JSON.stringify(entry);
  for (const res of sseClients) {
    res.write(`data: ${data}\n\n`);
  }
};
scheduler.onProgress = (progress) => {
  const data = JSON.stringify(progress);
  for (const res of sseClients) {
    res.write(`event: progress\ndata: ${data}\n\n`);
  }
};

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function sendHtml(res, filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(content);
}

function readBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // 静态文件
  if (pathname === '/' || pathname === '/index.html') {
    return sendHtml(res, path.join(__dirname, '..', 'public', 'index.html'));
  }

  // SSE 实时日志
  if (pathname === '/api/logs/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // API 路由
  if (pathname === '/api/status') {
    return sendJson(res, {
      ...scheduler.getStatus(),
      configState: getConfigState(),
      version: APP_VERSION,
    });
  }

  if (pathname === '/api/pending-count') {
    try {
      ensureFeishuConfigReady();
      const records = await feishu.getRecords();
      const count = records
        .map(r => feishu.parseRecord(r))
        .filter(isPendingRecord)
        .length;
      return sendJson(res, { success: true, count });
    } catch (e) {
      return sendJson(res, { success: false, error: e.message }, e.statusCode || 500);
    }
  }

  if (pathname === '/api/records') {
    try {
      ensureFeishuConfigReady();
      const records = await feishu.getUnpublishedRecords();
      const parsed = records.map(r => decorateRecord(feishu.parseRecord(r)));
      return sendJson(res, { success: true, data: parsed });
    } catch (e) {
      return sendJson(res, { success: false, error: e.message }, e.statusCode || 500);
    }
  }

  if (pathname === '/api/all-records') {
    try {
      ensureFeishuConfigReady();
      const records = await feishu.getRecords();
      const parsed = records.map(r => decorateRecord(feishu.parseRecord(r)));
      return sendJson(res, { success: true, data: parsed });
    } catch (e) {
      return sendJson(res, { success: false, error: e.message }, e.statusCode || 500);
    }
  }

  if (pathname === '/api/import/preflight' && req.method === 'GET') {
    try {
      ensureFeishuConfigReady();
      const REQUIRED_IMPORT_FIELDS = [
        '笔记主题', '标题', '正文', '标签', '素材',
        '发布时间', '小红书账号', '小红书发布状态', '小红书发布渠道',
        '抖音账号', '抖音发布状态',
        // 「内容类型」「导入指纹」是可选增强字段，表格没有也不影响导入
      ];
      const fields = await feishu.getTableFields();
      // getTableFields() 已返回 string[]，直接用
      const existingFieldNames = Array.isArray(fields) ? fields : [];
      const missingFields = REQUIRED_IMPORT_FIELDS.filter(fieldName => !existingFieldNames.includes(fieldName));
      if (missingFields.length === 0) {
        return sendJson(res, { ok: true });
      }
      return sendJson(res, { ok: false, missingFields });
    } catch (err) {
      return sendJson(res, { error: err.message }, 500);
    }
  }

  if (pathname === '/api/import/scan-folder' && req.method === 'POST') {
    readBody(req).then((body) => {
      try {
        const { folderPath } = JSON.parse(body || '{}');
        if (!folderPath || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
          return sendJson(res, { error: '目录不存在: ' + folderPath }, 400);
        }

        // 把扫描通过的根目录加入 /api/file 白名单
        approveImportRoot(folderPath);

        const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
        const videoExtensions = new Set(['.mp4', '.mov', '.avi', '.mkv']);

        // 文件名排序键：优先按"纯数字编号 [+ 子序号]"解析，解析失败回退 localeCompare numeric。
        // 这样 0.png / 0.1.png / 1.png / 1.1.png / 10.png / 1(1).png 都能正确排：
        //   parseAttachmentSortKey 把 "0.png" → [0, -1]，"0.1.png" → [0, 1]，sub=-1 排在 sub=0/1/2 前面，
        //   保证 0 < 0.1 < 1 < 1.1 < 10 这种用户直觉顺序。
        function compareEntryNames(a, b) {
          const ka = parseAttachmentSortKey(a);
          const kb = parseAttachmentSortKey(b);
          if (ka && kb) {
            return ka[0] - kb[0] || ka[1] - kb[1];
          }
          if (ka) return -1;
          if (kb) return 1;
          return a.localeCompare(b, 'zh-CN', { numeric: true });
        }

        // 从一个目录收集图片（包含直接的和子文件夹里的，extraDepth 控制再向下几层）
        function collectImagesFromDir(dirPath, extraDepth) {
          const entries = fs.readdirSync(dirPath, { withFileTypes: true })
            .filter(e => !e.name.startsWith('.'))
            .sort((a, b) => compareEntryNames(a.name, b.name));
          const images = [];
          let hasVideo = false;
          for (const entry of entries) {
            const p = path.join(dirPath, entry.name);
            if (entry.isFile()) {
              const ext = path.extname(entry.name).toLowerCase();
              if (imageExtensions.has(ext)) {
                images.push({ name: entry.name, path: p, size: fs.statSync(p).size });
              } else if (videoExtensions.has(ext)) {
                hasVideo = true;
              }
            } else if (entry.isDirectory() && extraDepth > 0) {
              const sub = collectImagesFromDir(p, extraDepth - 1);
              images.push(...sub.images);
              if (sub.hasVideo) hasVideo = true;
            }
          }
          return { images, hasVideo };
        }

        function isLeafNoteDir(dirPath, allowedImageExtensions) {
          const entries = fs.readdirSync(dirPath, { withFileTypes: true })
            .filter(entry => !entry.name.startsWith('.'));
          return entries.some(entry => entry.isFile() && allowedImageExtensions.has(path.extname(entry.name).toLowerCase()));
        }

        function detectScanMode(rootPath, firstLevelDirs, allowedImageExtensions) {
          if (firstLevelDirs.length === 0) return 'multi';
          const leafDirCount = firstLevelDirs.reduce((count, entry) => {
            const dirPath = path.join(rootPath, entry.name);
            return count + (isLeafNoteDir(dirPath, allowedImageExtensions) ? 1 : 0);
          }, 0);
          return (leafDirCount / firstLevelDirs.length) >= 0.8 ? 'single' : 'multi';
        }

        const firstLevelDirs = fs.readdirSync(folderPath, { withFileTypes: true })
          .filter(entry => !entry.name.startsWith('.') && entry.isDirectory())
          .sort((a, b) => compareEntryNames(a.name, b.name));

        const scanMode = detectScanMode(folderPath, firstLevelDirs, imageExtensions);
        let result;

        if (scanMode === 'single') {
          const topicName = path.basename(folderPath);
          const notes = firstLevelDirs.map(noteEntry => {
            const noteFolderPath = path.join(folderPath, noteEntry.name);
            const { images, hasVideo } = collectImagesFromDir(noteFolderPath, 1);
            const warnings = hasVideo ? ['包含视频文件（v2.0 不支持，已跳过）'] : [];
            return {
              noteKey: `${topicName}/${noteEntry.name}`,
              folderName: noteEntry.name,
              folderPath: noteFolderPath,
              images,
              imageCount: images.length,
              firstImagePath: images[0]?.path || '',
              hasVideo,
              warnings,
            };
          });

          result = [{
            topic: topicName,
            path: folderPath,
            notes,
            scanMode,
          }];
        } else {
          result = firstLevelDirs.map(topicEntry => {
            const topicPath = path.join(folderPath, topicEntry.name);
            const topicChildren = fs.readdirSync(topicPath, { withFileTypes: true })
              .filter(e => !e.name.startsWith('.'))
              .sort((a, b) => compareEntryNames(a.name, b.name));

            const noteFolders = topicChildren.filter(e => e.isDirectory());
            const directImages = topicChildren
              .filter(e => e.isFile() && imageExtensions.has(path.extname(e.name).toLowerCase()))
              .map(e => {
                const p = path.join(topicPath, e.name);
                return { name: e.name, path: p, size: fs.statSync(p).size };
              });

            let notes;

            if (noteFolders.length > 0) {
              // 有子文件夹 → 每个子文件夹是一篇笔记
              // 笔记内图片可能直接在里面，也可能在再下一层子文件夹（extraDepth=1 兼容两种情况）
              notes = noteFolders.map(noteEntry => {
                const noteFolderPath = path.join(topicPath, noteEntry.name);
                const { images, hasVideo } = collectImagesFromDir(noteFolderPath, 1);
                const warnings = hasVideo ? ['包含视频文件（v2.0 不支持，已跳过）'] : [];
                return {
                  noteKey: `${topicEntry.name}/${noteEntry.name}`,
                  folderName: noteEntry.name,
                  folderPath: noteFolderPath,
                  images,
                  imageCount: images.length,
                  firstImagePath: images[0]?.path || '',
                  hasVideo,
                  warnings,
                };
              });
            } else {
              // 没有子文件夹 → 主题文件夹本身当作一篇笔记，图片直接在里面
              const hasVideo = topicChildren.some(e => e.isFile() && videoExtensions.has(path.extname(e.name).toLowerCase()));
              notes = directImages.length > 0 ? [{
                noteKey: `${topicEntry.name}/${topicEntry.name}`,
                folderName: topicEntry.name,
                folderPath: topicPath,
                images: directImages,
                imageCount: directImages.length,
                firstImagePath: directImages[0]?.path || '',
                hasVideo,
                warnings: hasVideo ? ['包含视频文件（v2.0 不支持，已跳过）'] : [],
              }] : [];
            }

            return { topic: topicEntry.name, notes, scanMode };
          });
        }

        return sendJson(res, result);
      } catch (e) {
        return sendJson(res, { error: e.message }, 500);
      }
    }).catch(e => sendJson(res, { error: e.message }, e.statusCode || 500));
    return;
  }

  if (pathname === '/api/import/schedule' && req.method === 'POST') {
    readBody(req).then((body) => {
      try {
        const payload = JSON.parse(body || '{}');
        return sendJson(res, allocateImportSchedule(payload));
      } catch (e) {
        return sendJson(res, { error: e.message }, e.statusCode || (e instanceof SyntaxError ? 400 : 500));
      }
    }).catch(e => sendJson(res, { error: e.message }, e.statusCode || 500));
    return;
  }

  if (pathname === '/api/import/archive' && req.method === 'POST') {
    readBody(req).then((body) => {
      try {
        const payload = JSON.parse(body || '{}');
        return sendJson(res, archiveImportFolders(payload));
      } catch (e) {
        return sendJson(res, { error: e.message }, e.statusCode || (e instanceof SyntaxError ? 400 : 500));
      }
    }).catch(e => sendJson(res, { error: e.message }, e.statusCode || 500));
    return;
  }

  // 本地图片文件中转（Electron 页面 file:// 受限，改由 HTTP 接口提供）
  // 安全限制：只允许本地请求 + 路径必须在已扫描的素材根目录白名单内
  if (pathname === '/api/file' && req.method === 'GET') {
    if (!isLocalRequest(req)) return sendJson(res, { error: 'forbidden' }, 403);
    const filePath = new URL(req.url, 'http://localhost').searchParams.get('path');
    if (!filePath) return sendJson(res, { error: 'missing path' }, 400);
    const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif', '.bmp']);
    const ext = path.extname(filePath).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return sendJson(res, { error: 'unsupported type' }, 400);
    if (!isPathInApprovedRoots(filePath)) return sendJson(res, { error: 'path not in approved roots' }, 403);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return sendJson(res, { error: 'not a file' }, 400);
      const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic', '.heif': 'image/heif', '.bmp': 'image/bmp' };
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'image/jpeg', 'Content-Length': stat.size, 'Cache-Control': 'private,max-age=3600' });
      fs.createReadStream(filePath).pipe(res);
    } catch (e) {
      return sendJson(res, { error: e.message }, 404);
    }
    return;
  }

  if (pathname === '/api/import/create-records' && req.method === 'POST') {
    // 诊断日志写到 ~/Library/Caches/Zhifa/logs/import-debug.log
    // 跟 publisher-debug.log 同模式,记录 createRecord/updateRecord 的请求 fields + 飞书响应,
    // 用户报「成功但表格里没记录」时直接看这个文件就能定位
    const importDebugLog = (() => {
      try {
        const paths = getRuntimePaths();
        if (!fs.existsSync(paths.logsDir)) fs.mkdirSync(paths.logsDir, { recursive: true });
        return path.join(paths.logsDir, 'import-debug.log');
      } catch (_) { return null; }
    })();
    const writeImportLog = (label, obj) => {
      if (!importDebugLog) return;
      try {
        if (fs.existsSync(importDebugLog)) {
          const stat = fs.statSync(importDebugLog);
          if (stat.size > 10 * 1024 * 1024) {
            fs.writeFileSync(importDebugLog, `===== [${new Date().toISOString()}] 日志超 10MB,已自动清空 =====\n`, 'utf-8');
          }
        }
        const line = `\n===== [${new Date().toISOString()}] ${label} =====\n${typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)}\n`;
        fs.appendFileSync(importDebugLog, line, 'utf-8');
      } catch (_) {}
    };

    try {
      ensureFeishuConfigReady();
      const body = JSON.parse(await readBody(req) || '{}');
      const { dryRun = false, records = [] } = body;

      // 预取飞书字段列表，用于判断可选字段是否存在（避免 FieldNameNotFound）
      const tableFieldNames = await feishu.getTableFields().catch(() => []);
      const tableFieldSet = new Set(Array.isArray(tableFieldNames) ? tableFieldNames : []);

      // 「导入指纹」字段不存在时自动创建（文本类型）
      // 用于跨批次查重，避免重复导入同一内容
      if (!tableFieldSet.has('导入指纹')) {
        try {
          await feishu.createTextField('导入指纹');
          tableFieldSet.add('导入指纹');
          writeImportLog('自动创建字段「导入指纹」成功', {});
        } catch (createErr) {
          // 创建失败不阻断导入，只是这批次查重和指纹写入会跳过
          writeImportLog('自动创建字段「导入指纹」失败（已跳过）', { error: createErr.message });
        }
      }

      const results = [];
      const total = records.length;
      let current = 0;
      // 跟踪每条记录用到的图片路径,本批结束后清掉成功记录的 recovery 缓存,
      // 失败的保留供下次重试复用(B4 断点续传)
      const recordImagesByNoteKey = new Map();
      // 同主题 AI 结果缓存：topic → {title, description, tags}
      // key 用归一化后的字符串(全角空格→半角、连续空白合并、去首尾空白),
      // 防止「主题A 」「主题A」「主题A 」(尾随全角空格)被当成不同 key 重复调 AI
      const topicAiCache = new Map();
      const normalizeTopicKey = (s) => String(s || '')
        .replace(/　/g, ' ')   // 全角空格 → 半角
        .replace(/\s+/g, ' ')      // 连续空白合并
        .trim();

      // SSE 进度推送辅助函数（仅 dryRun=false 时使用）
      const pushImportProgress = (noteKey, status) => {
        current++;
        const data = JSON.stringify({ type: 'import_progress', current, total, noteKey, status });
        for (const sseRes of sseClients) {
          sseRes.write(`event: import_progress\ndata: ${data}\n\n`);
        }
      };
      // 图片级别进度(每张图传完一次),给 UI 显示「N/M 张」,避免一篇笔记 16 张图传几十秒看起来卡死
      const pushImageProgress = (noteKey, done, totalImages, fileName) => {
        const data = JSON.stringify({
          type: 'import_image_progress',
          noteKey,
          done,
          total: totalImages,
          fileName: fileName || '',
        });
        for (const sseRes of sseClients) {
          sseRes.write(`event: import_image_progress\ndata: ${data}\n\n`);
        }
      };

      for (const record of records) {
        const {
          topic = '',
          topicOverride = '',
          noteKey = '',
          folderPath: recordFolderPath = '',
          images = [],
          xiaohongshuAccount = '',
          douyinAccount = '',
          publishTime = '',
          xiaohongshuChannel = '蚁小二',
          title = '',
          description = '',
          tags = [],
          overwrite = false,
          overwriteId = '',
        } = record;

        // 是否覆盖模式（前端明确传 overwrite:true + overwriteId）
        const isOverwrite = !!(overwrite && overwriteId);

        // Step 1: 账号校验
        if (!xiaohongshuAccount && !douyinAccount) {
          results.push({ noteKey, status: 'failed', reason: 'no_account' });
          if (!dryRun) pushImportProgress(noteKey, 'failed');
          continue;
        }

        // 取文件夹名（noteKey 最后一段）
        const noteFolder = noteKey.split('/').pop() || recordFolderPath.split('/').pop() || '';

        // Step 2: 指纹计算（始终计算，供查重和写入 导入指纹 字段使用）
        // 【Fix 问题2】双平台导入时分别计算两个指纹，存储时合并为换行分隔，
        // 查重用 contains 操作符（见 feishu.findRecordByFingerprint），
        // 保证"双平台首次导入 → 单平台再次导入"也能命中查重。
        const imgNamesSorted = images.map(i => i.name).sort().join(',');
        const imgSizesSorted = images.slice().sort((a, b) => a.name.localeCompare(b.name)).map(i => i.size).join(',');

        let xhsFingerprint = '';
        let douyinFingerprint = '';
        if (xiaohongshuAccount) {
          xhsFingerprint = crypto.createHash('sha256')
            .update([topic, noteFolder, 'xiaohongshu', xiaohongshuAccount, imgNamesSorted, imgSizesSorted].join('|'))
            .digest('hex');
        }
        if (douyinAccount) {
          douyinFingerprint = crypto.createHash('sha256')
            .update([topic, noteFolder, 'douyin', douyinAccount, imgNamesSorted, imgSizesSorted].join('|'))
            .digest('hex');
        }
        // storedFingerprint：两个平台都有时换行合并，只有一个时单独存
        const primaryFingerprint = xhsFingerprint || douyinFingerprint;
        const storedFingerprint = (xhsFingerprint && douyinFingerprint)
          ? `${xhsFingerprint}\n${douyinFingerprint}`
          : primaryFingerprint;

        // 非覆盖模式：查重，命中则跳过并返回旧记录发布状态
        if (!isOverwrite) {
          let fingerprintExists = false;
          let existingRecordId = null;

          // 逐个指纹查重（feishu.findRecordByFingerprint 用 contains，双平台合并字段也能命中）
          if (xhsFingerprint) {
            const existingId = await feishu.findRecordByFingerprint(xhsFingerprint);
            if (existingId) { fingerprintExists = true; existingRecordId = existingId; }
          }
          if (!fingerprintExists && douyinFingerprint) {
            const existingId = await feishu.findRecordByFingerprint(douyinFingerprint);
            if (existingId) { fingerprintExists = true; existingRecordId = existingId; }
          }

          if (fingerprintExists) {
            // 获取旧记录的发布状态，供前端展示覆盖警告
            let existingStatus = '';
            try {
              const existingRec = await feishu.getRecordById(existingRecordId);
              const f = existingRec?.fields || {};
              existingStatus = String(f['小红书发布状态'] || f['抖音发布状态'] || '');
            } catch (_) {}
            results.push({ noteKey, status: 'skipped', reason: 'fingerprint_exists', recordId: existingRecordId, existingStatus });
            if (!dryRun) pushImportProgress(noteKey, 'skipped');
            continue;
          }
        }

        // 【Fix 问题3】覆盖模式：服务端校验 overwriteId 对应的记录存在，
        // 防止前端传错 ID 导致意外覆盖无关记录
        if (isOverwrite) {
          try {
            const targetRec = await feishu.getRecordById(overwriteId);
            if (!targetRec) {
              results.push({ noteKey, status: 'failed', reason: 'overwrite_target_not_found', message: `recordId ${overwriteId} 不存在` });
              if (!dryRun) pushImportProgress(noteKey, 'failed');
              continue;
            }
          } catch (verifyErr) {
            results.push({ noteKey, status: 'failed', reason: 'overwrite_target_not_found', message: verifyErr.message });
            if (!dryRun) pushImportProgress(noteKey, 'failed');
            continue;
          }
        }

        // Step 3: AI 内容生成（B-2）
        // 同一主题只调用一次 AI，后续笔记直接复用（节省 API 开销）
        let aiTitle = title;
        let aiDescription = description;
        let aiTags = Array.isArray(tags) ? tags : [];
        const topicForAi = typeof topicOverride === 'string' && topicOverride.trim()
          ? topicOverride.trim()
          : topic;

        if (!aiTitle) {
          const aiConfig = config.aiWriting;
          if (aiConfig && aiConfig.enabled && aiConfig.apiKey) {
            // 缓存 key 用 noteKey（文件夹维度），而不是 topic
            // 原因：同一主题下多个文件夹应各自生成独立内容，不能复用；
            // 但同一文件夹的重试（同 noteKey）可以复用上次结果，避免重复调 API
            const cacheKey = noteKey || normalizeTopicKey(topicForAi);
            try {
              if (cacheKey && topicAiCache.has(cacheKey)) {
                // 同一文件夹已生成过（重试场景），直接复用
                const cached = topicAiCache.get(cacheKey);
                aiTitle = cached.title;
                aiDescription = cached.description;
                aiTags = cached.tags;
              } else {
                const aiRecord = {
                  topic: topicForAi,
                  attachments: images.map(i => ({ name: i.name })),
                  xiaohongshuAccount,
                  douyinAccount,
                  imagePaths: images.map(i => i.path), // 传实际路径供 AI 视觉识别
                };
                const aiResult = await generateContent(aiConfig, aiRecord);
                aiTitle = aiResult.title || '';
                aiDescription = aiResult.description || '';
                aiTags = Array.isArray(aiResult.tags) ? aiResult.tags : [];
                // AI 多模态截断信息(IMAGE_MAX_COUNT=8 时,16 张图只送 8 张),记到 record 上,
                // 后续 results 会带上,前端可展示「AI 仅参考前 N 张图」提示
                if (aiResult._meta && aiResult._meta.truncated) {
                  record.__aiImagesTruncated = aiResult._meta;
                }
                if (cacheKey) topicAiCache.set(cacheKey, { title: aiTitle, description: aiDescription, tags: aiTags });
              }
            } catch (aiErr) {
              // AI 生成失败：dryRun 阶段把错误信息回传给前端展示「跳过/空建/重试」选项；
              // 真正导入阶段（dryRun=false）降级为"空内容继续上传"——账号、时间、图片正常处理，
              // 只是标题/正文/标签为空，用户可以在飞书里手动补内容。这样 AI 偶发失败不会卡住整批。
              if (dryRun) {
                results.push({ noteKey, status: 'failed', reason: 'ai_error', message: aiErr.message });
                continue;
              }
              // 非 dryRun：降级处理，记 warning 但继续走完图片上传 + 写飞书
              aiTitle = '';
              aiDescription = '';
              aiTags = [];
              // record.__aiFailureWarning 是临时局部属性,前端拿不到;
              // 真正暴露给前端:在 results 里用专门字段(下面 success 分支会把它带上)
              record.__aiFailureWarning = aiErr.message;
            }
          }
        }

        // dryRun: 只返回 AI 生成内容，不写飞书
        if (dryRun) {
          const previewMeta = record.__aiImagesTruncated;
          results.push({
            noteKey,
            status: 'preview',
            title: aiTitle,
            description: aiDescription,
            tags: aiTags,
            ...(previewMeta ? { aiImagesTruncated: previewMeta } : {}),
          });
          continue;
        }

        // Step 4: 图片上传（B-3）
        // 并发 3 路 + 每张完成后推 SSE,UI 能看到「正在传 5/16 张」之类的实时进度
        // 启用断点续传 (useRecovery=true,默认):中途失败的下次重试自动跳过已成功的图
        const imagePathsForRecord = images.map(i => i.path);
        recordImagesByNoteKey.set(noteKey, imagePathsForRecord);
        let uploadedTokens = [];
        try {
          const uploaded = await feishu.uploadLocalImagesToFeishu(
            imagePathsForRecord,
            {
              concurrency: 3,
              useRecovery: true,
              onProgress: (done, totalImages, fileName, fromCache) => {
                pushImageProgress(noteKey, done, totalImages, fileName);
                // fromCache=true 说明这张图复用了之前批次上传成功的缓存
                // 不影响 done 计数,只影响日志可读性,这里暂不区分
              },
            }
          );
          uploadedTokens = uploaded.map(u => ({ file_token: u.fileToken }));
        } catch (uploadErr) {
          results.push({ noteKey, status: 'failed', reason: 'upload_error', message: uploadErr.message });
          pushImportProgress(noteKey, 'failed');
          continue;
        }

        // Step 5: 组装飞书字段并建单（B-3）
        const fields = {
          '笔记主题': topic,
        };
        // 「内容类型」「导入指纹」属于可选增强字段，用户表格中可能不存在
        // 只在字段实际存在时才写入，避免 code=1254045 FieldNameNotFound
        if (tableFieldSet.has('内容类型')) fields['内容类型'] = '图文';
        if (tableFieldSet.has('导入指纹') && storedFingerprint) fields['导入指纹'] = storedFingerprint;
        if (aiTitle) fields['标题'] = aiTitle;
        if (aiDescription) fields['正文'] = aiDescription;
        if (aiTags.length) fields['标签'] = aiTags.join('\n');
        if (uploadedTokens.length) fields['素材'] = uploadedTokens;
        // 发布时间（字符串 "YYYY-MM-DD HH:mm" → 毫秒时间戳）
        if (publishTime) {
          const ts = new Date(publishTime).getTime();
          if (!isNaN(ts)) fields['发布时间'] = ts;
        }

        // 【Fix 问题1 + 2026-05-06 调整】平台字段组装：
        // 上传只建档不触发自动发布——发布状态字段一律不写（保持空），
        // 由人工在飞书侧手动改成"待发布"才进入调度链路。
        // 覆盖模式：账号/渠道字段还需要显式重置，防止旧账号残留。
        if (isOverwrite) {
          // 显式重置账号/渠道，避免旧账号继续进入调度链路；状态保持空
          fields['小红书账号'] = xiaohongshuAccount || '';
          fields['小红书发布状态'] = '';
          fields['小红书发布渠道'] = xiaohongshuAccount ? (xiaohongshuChannel || '蚁小二') : '';
          fields['抖音账号'] = douyinAccount || '';
          fields['抖音发布状态'] = '';
        } else {
          if (xiaohongshuAccount) {
            fields['小红书账号'] = xiaohongshuAccount;
            fields['小红书发布渠道'] = xiaohongshuChannel || '蚁小二';
            // 不写小红书发布状态——让人工手动设"待发布"才触发调度
          }
          if (douyinAccount) {
            fields['抖音账号'] = douyinAccount;
            // 不写抖音发布状态——让人工手动设"待发布"才触发调度
          }
        }

        // 把 AI 失败降级 warning + 多模态截断信息一并带上,前端可以展示
        // 「这条 AI 生成失败,标题/正文已留空,请到飞书手动补」/「AI 只参考了前 N 张图」
        const aiWarning = record.__aiFailureWarning || null;
        const aiTruncMeta = record.__aiImagesTruncated || null;
        const extraMeta = {
          ...(aiWarning ? { aiDegraded: true, aiError: aiWarning } : {}),
          ...(aiTruncMeta ? { aiImagesTruncated: aiTruncMeta } : {}),
        };
        // 写一份诊断:noteKey + 即将提交的 fields(脱敏:不打印 file_token 完整值,只打数量)
        writeImportLog(`即将建单 noteKey=${noteKey}`, {
          isOverwrite,
          overwriteId: isOverwrite ? overwriteId : null,
          fieldsKeys: Object.keys(fields),
          fieldSamples: {
            笔记主题: fields['笔记主题'],
            标题: fields['标题'] || '(空)',
            正文长度: (fields['正文'] || '').length,
            标签数: (fields['标签'] || '').split('\n').filter(Boolean).length,
            素材张数: (fields['素材'] || []).length,
            小红书账号: fields['小红书账号'] || '(无)',
            抖音账号: fields['抖音账号'] || '(无)',
            发布时间: fields['发布时间'] || '(无)',
          },
        });
        try {
          if (isOverwrite) {
            await feishu.updateRecord(overwriteId, fields);
            writeImportLog(`updateRecord 成功 noteKey=${noteKey}`, { recordId: overwriteId });
            results.push({
              noteKey,
              status: 'success',
              recordId: overwriteId,
              overwritten: true,
              ...extraMeta,
            });
          } else {
            const { recordId } = await feishu.createRecord(fields);
            writeImportLog(`createRecord 成功 noteKey=${noteKey}`, { recordId });
            results.push({
              noteKey,
              status: 'success',
              recordId,
              ...extraMeta,
            });
          }
          pushImportProgress(noteKey, 'success');
        } catch (feishuErr) {
          // 飞书业务错误(code != 0 / record_id 缺失)现在能拿到具体 message
          // 把飞书原始 code/msg 也透给前端,失败 UI 不再是模糊的「feishu_error」
          writeImportLog(`建单失败 noteKey=${noteKey}`, {
            message: feishuErr.message,
            feishuCode: feishuErr.feishuCode || null,
            feishuMsg: feishuErr.feishuMsg || null,
            stack: feishuErr.stack,
          });
          results.push({
            noteKey,
            status: 'failed',
            reason: 'feishu_error',
            message: feishuErr.message,
            ...(feishuErr.feishuCode ? { feishuCode: feishuErr.feishuCode } : {}),
            ...(feishuErr.feishuMsg ? { feishuMsg: feishuErr.feishuMsg } : {}),
          });
          pushImportProgress(noteKey, 'failed');
        }
      }

      // 整批结束:对成功的记录,把对应图片路径从 recovery 缓存清掉(避免长期堆积);
      // 失败的记录不清,保留缓存供用户重试时复用,实现断点续传
      try {
        const successfulImagePaths = [];
        for (const r of results) {
          if (r.status === 'success' && recordImagesByNoteKey.has(r.noteKey)) {
            const paths = recordImagesByNoteKey.get(r.noteKey);
            if (Array.isArray(paths)) successfulImagePaths.push(...paths);
          }
        }
        if (successfulImagePaths.length > 0) {
          feishu.clearImportRecoveryFor(successfulImagePaths);
        }
      } catch (_) {
        // 清理失败不影响主流程,缓存条目最迟 24h 自然过期
      }

      return sendJson(res, { results });
    } catch (err) {
      return sendJson(res, { error: err.message }, 500);
    }
  }

  if (pathname === '/api/scheduler/start' && req.method === 'POST') {
    scheduler.start();
    return sendJson(res, { success: true, message: '定时服务已启动：系统会立即补扫，并继续处理还没完成的定时任务' });
  }

  if (pathname === '/api/scheduler/stop' && req.method === 'POST') {
    const stopState = scheduler.stop();
    return sendJson(res, {
      success: true,
      message: stopState?.draining
        ? '定时服务已停止：当前正在发布的记录会收尾，未开始的定时任务已暂停'
        : '定时服务已停止：未开始的定时任务已暂停',
    });
  }

  if (pathname === '/api/publish/scheduled-tasks' && req.method === 'GET') {
    sendJson(res, { success: true, data: scheduler.getScheduledTasks() });
    return;
  }

  if (pathname === '/api/publish/now' && req.method === 'POST') {
    readBody(req).then(async () => {
      try {
        const result = await scheduler.manualPublishNow();
        if (result && result.error) {
          return sendJson(res, { success: false, ...result }, 500);
        }
        sendJson(res, { success: true, ...result });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
    }).catch(e => sendJson(res, { success: false, error: e.message }, e.statusCode || 500));
    return;
  }

  if (pathname === '/api/publish/record' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      try {
        const { recordId } = JSON.parse(body || '{}');
        if (!recordId) return sendJson(res, { success: false, error: '缺少 recordId' }, 400);
        const result = await scheduler.publishSpecificRecord(recordId);
        if (result && result.error) {
          return sendJson(res, { success: false, ...result }, 500);
        }
        sendJson(res, { success: true, ...result });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
    }).catch(e => sendJson(res, { success: false, error: e.message }, e.statusCode || 500));
    return;
  }

  // 强制重发（仅同账号）：清掉本地 ledger 里某条 recordId+platform 的命中
  // 服务端校验：当前飞书账号必须 ∈ 历史血统账号集合，否则拒绝
  if (pathname === '/api/force-republish' && req.method === 'POST') {
    // 安全：仅允许本机请求 + Host 头校验，防御 DNS rebinding / 局域网横向访问
    if (!isLocalRequest(req)) {
      return sendJson(res, { success: false, error: '🚨 拒绝：force-republish 仅允许本机访问' }, 403);
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { recordId, platform } = JSON.parse(body || '{}');
        if (!recordId || !platform) {
          return sendJson(res, { success: false, error: '缺少 recordId 或 platform' }, 400);
        }
        if (platform !== '小红书' && platform !== '抖音') {
          return sendJson(res, { success: false, error: '不支持的平台' }, 400);
        }
        // 1. 拉飞书最新记录，取当前账号
        const remote = await feishu.getRecordById(recordId);
        if (!remote) {
          return sendJson(res, { success: false, error: '飞书记录不存在' }, 404);
        }
        const parsed = feishu.parseRecord(remote);
        const currentAccount = platform === '小红书' ? parsed.xiaohongshuAccount : parsed.douyinAccount;
        if (!currentAccount) {
          return sendJson(res, { success: false, error: `当前记录没有配置${platform}账号` }, 400);
        }
        // 2. 校验历史血统
        const history = publisher.getHistoryAccounts(recordId, platform);
        if (history.length > 0 && !history.includes(String(currentAccount).trim())) {
          return sendJson(res, {
            success: false,
            error: `🚨 红线保护：拒绝强制重发到非历史账号。历史账号=[${history.join(',')}]，当前账号=[${currentAccount}]`,
            historyAccounts: history,
            currentAccount,
          }, 403);
        }
        // 3. 清本地 ledger，把飞书状态改回"待发布"以便下次 checkAndPublish 重发
        publisher.unmarkAsPublished(recordId, platform);
        await feishu.markPlatformStatus(recordId, platform, '待发布');
        return sendJson(res, {
          success: true,
          message: `已允许 ${platform}(${currentAccount}) 同账号重发，下次发布检查时会重新提交`,
          historyAccounts: history,
        });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
    });
    return;
  }

  if (pathname === '/api/accounts') {
    try {
      ensureYixiaoerConfigReady();
      await publisher.ensureLogin(config.yixiaoer);
      const accounts = await publisher.getAccountList({ loginStatus: 1 });
      return sendJson(res, { success: true, data: accounts });
    } catch (e) {
      return sendJson(res, { success: false, error: e.message }, e.statusCode || 500);
    }
  }

  if (pathname === '/api/accounts/status') {
    try {
      ensureYixiaoerConfigReady();
      await publisher.ensureLogin(config.yixiaoer);
      const accounts = await publisher.getAccountList();
      let configChanged = false;

      const cacheResult = updateYixiaoerAccountCache(config, accounts, publisher.collectAccountAliases);
      configChanged = configChanged || cacheResult.changed;

      if (isFeishuConfigured(config)) {
        const desiredNames = {
          xiaohongshu: await feishu.getSingleSelectFieldOptionNames('小红书账号'),
          douyin: await feishu.getSingleSelectFieldOptionNames('抖音账号'),
        };
        const autoMapResult = autoMapAccountMappings(config, desiredNames, accounts, publisher.collectAccountAliases);
        configChanged = configChanged || autoMapResult.changed;
      }

      if (configChanged) {
        saveConfig();
      }

      const mappedIds = collectMappedAccountIds(config);
      const data = accounts.map(account => ({
        id: account.id,
        platform: account.platformName,
        accountName: account.platformAccountName,
        status: account.status,
        isFreeze: !!account.isFreeze,
        isOperate: account.isOperate !== false,
        isRealNameVerified: account.isRealNameVerified !== false,
        statusText: account.status === 1 && !account.isFreeze && account.isOperate !== false
          ? '在线/授权正常'
          : '需关注',
        mapped: mappedIds.has(account.id),
        aliases: publisher.collectAccountAliases(account),
      }));
      return sendJson(res, { success: true, data });
    } catch (e) {
      return sendJson(res, { success: false, error: e.message }, e.statusCode || 500);
    }
  }

  if (pathname === '/api/config') {
    if (req.method === 'GET') {
      const safeConfig = JSON.parse(JSON.stringify(config));
      if (safeConfig.yixiaoer.password) safeConfig.yixiaoer.password = '******';
      if (safeConfig.yixiaoer.apiKey) safeConfig.yixiaoer.apiKey = '******';
      if (safeConfig.yixiaoer.clientId) safeConfig.yixiaoer.clientId = '******';
      if (safeConfig.feishu.appSecret) safeConfig.feishu.appSecret = '******';
      safeConfig.configState = getConfigState();
      safeConfig.runtimePaths = getPublicRuntimePaths();
      return sendJson(res, safeConfig);
    }
  }

  if (pathname === '/api/config/export' && req.method === 'GET') {
    const stamp = buildBackupStamp();
    const filename = `zhifa-config-backup-${stamp}.json`;
    writeJsonDownload(res, filename, cloneConfigForExport());
    return;
  }

  if (pathname === '/api/config/import' && req.method === 'POST') {
    readBody(req).then((body) => {
      try {
        const payload = JSON.parse(body || '{}');
        const importedConfig = payload.config;
        if (!importedConfig || typeof importedConfig !== 'object' || Array.isArray(importedConfig)) {
          return sendJson(res, { success: false, error: '导入的配置格式错误' }, 400);
        }

        syncConfigObject(persistConfig(importedConfig));
        refreshFeishuClients();
        publisher.resetRuntimeState();
        restartSchedulerIfRunning();

        return sendJson(res, {
          success: true,
          message: '配置备份已导入，当前运行配置已刷新',
          configState: getConfigState(),
          runtimePaths: getPublicRuntimePaths(),
        });
      } catch (e) {
        return sendJson(res, { success: false, error: e.message }, e.statusCode || 500);
      }
    }).catch(e => sendJson(res, { success: false, error: e.message }, e.statusCode || 500));
    return;
  }

  if (pathname === '/api/data/export' && req.method === 'GET') {
    const stamp = buildBackupStamp();
    const filename = `zhifa-data-backup-${stamp}.json`;
    writeJsonDownload(res, filename, cloneDataBackupForExport());
    return;
  }

  if (pathname === '/api/data/import' && req.method === 'POST') {
    readBody(req).then((body) => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = applyImportedDataBackup(payload.backup);
        return sendJson(res, {
          success: true,
          message: '完整数据备份已导入，配置和发布账本已刷新',
          ...result,
        });
      } catch (e) {
        return sendJson(res, { success: false, error: e.message }, e.statusCode || 500);
      }
    }).catch(e => sendJson(res, { success: false, error: e.message }, e.statusCode || 500));
    return;
  }

  if (pathname === '/api/config/feishu' && req.method === 'POST') {
    readBody(req).then((body) => {
      try {
        const payload = JSON.parse(body || '{}');
        const next = payload.feishu || {};
        const appId = String(next.appId || '').trim();
        const appSecret = String(next.appSecret || '').trim();
        const wikiUrl = String(next.wikiUrl || '').trim();
        const appToken = String(next.appToken || '').trim();
        const tableId = String(next.tableId || '').trim();

        if (!appId) {
          return sendJson(res, { success: false, error: '飞书 App ID 不能为空' }, 400);
        }
        if (!appToken) {
          return sendJson(res, { success: false, error: '飞书 App Token 不能为空' }, 400);
        }
        if (!tableId) {
          return sendJson(res, { success: false, error: '飞书 Table ID 不能为空' }, 400);
        }

        config.feishu = config.feishu || {};
        config.feishu.appId = appId;
        config.feishu.appToken = appToken;
        config.feishu.tableId = tableId;
        config.feishu.wikiUrl = wikiUrl;

        // 页面不回显真实 secret。空值或掩码都视为“保持不变”。
        if (appSecret && appSecret !== '******') {
          config.feishu.appSecret = appSecret;
        }

        if (!config.feishu.appSecret) {
          return sendJson(res, { success: false, error: '飞书 App Secret 不能为空' }, 400);
        }

        saveConfig();
        refreshFeishuClients();
        restartSchedulerIfRunning();

        return sendJson(res, {
          success: true,
          message: '飞书接入配置已保存',
          data: {
            appId: config.feishu.appId,
            wikiUrl: config.feishu.wikiUrl || '',
            appToken: config.feishu.appToken,
            tableId: config.feishu.tableId,
            appSecretConfigured: !!config.feishu.appSecret,
          }
        });
      } catch (e) {
        return sendJson(res, { success: false, error: e.message }, 500);
      }
    }).catch(e => sendJson(res, { success: false, error: e.message }, e.statusCode || 500));
    return;
  }

  if (pathname === '/api/bitbrowser/accounts' && req.method === 'GET') {
    try {
      ensureFeishuConfigReady();
      const data = await getBitBrowserAccountMappings();
      return sendJson(res, { success: true, data });
    } catch (e) {
      return sendJson(res, { success: false, error: e.message }, e.statusCode || 500);
    }
  }

  if (pathname === '/api/bitbrowser/accounts' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      try {
        const { mappings } = JSON.parse(body || '{}');
        if (!Array.isArray(mappings)) {
          return sendJson(res, { success: false, error: '映射数据格式错误' }, 400);
        }

        config.bitbrowser = config.bitbrowser || {};
        config.bitbrowser.xiaohongshu = config.bitbrowser.xiaohongshu || {};

        for (const item of mappings) {
          const accountName = String(item.accountName || '').trim();
          if (!accountName) continue;
          const browserId = String(item.browserId || '').trim();

          if (!browserId) {
            delete config.bitbrowser.xiaohongshu[accountName];
            continue;
          }

          config.bitbrowser.xiaohongshu[accountName] = { browserId };
        }

        saveConfig();
        const data = await getBitBrowserAccountMappings();
        return sendJson(res, { success: true, message: '比特浏览器账号映射已保存', data });
      } catch (e) {
        return sendJson(res, { success: false, error: e.message }, 500);
      }
    }).catch(e => sendJson(res, { success: false, error: e.message }, e.statusCode || 500));
    return;
  }

  if (pathname === '/api/bitbrowser/sync-feishu' && req.method === 'POST') {
    try {
      ensureFeishuConfigReady();
      const synced = await syncFeishuSelectFields();
      const data = await getBitBrowserAccountMappings();
      return sendJson(res, {
        success: true,
        message: `已同步飞书单选字段：小红书账号(${synced.accountNames.length}个选项)、小红书发布渠道(2个选项)`,
        data,
      });
    } catch (e) {
      return sendJson(res, { success: false, error: e.message }, e.statusCode || 500);
    }
  }

  // 更新定时配置
  if (pathname === '/api/schedule' && req.method === 'POST') {
    readBody(req).then((body) => {
      try {
        const schedule = JSON.parse(body);
        // 验证 periods 数组
        if (!Array.isArray(schedule.periods) || schedule.periods.length === 0) {
          return sendJson(res, { success: false, error: '至少需要一个时间段' }, 400);
        }
        if (schedule.periods.length > 10) {
          return sendJson(res, { success: false, error: '最多支持10个时间段' }, 400);
        }
        for (const p of schedule.periods) {
          if (!/^\d{2}:\d{2}$/.test(p.startTime) || !/^\d{2}:\d{2}$/.test(p.endTime)) {
            return sendJson(res, { success: false, error: '时间格式错误，应为 HH:MM' }, 400);
          }
          const interval = parseInt(p.intervalMinutes);
          if (isNaN(interval) || interval < 5 || interval > 480) {
            return sendJson(res, { success: false, error: '间隔应在5-480分钟之间' }, 400);
          }
          p.intervalMinutes = interval;
        }
        scheduler.updateSchedule(schedule);
        config.schedule = schedule;
        saveConfig();
        sendJson(res, { success: true, message: '定时配置已保存' });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
    }).catch(e => sendJson(res, { success: false, error: e.message }, e.statusCode || 500));
    return;
  }

  // 音乐设置相关 API
  if (pathname === '/api/music/default/validate' && req.method === 'GET') {
    try {
      ensureYixiaoerConfigReady();
      await publisher.ensureLogin(config.yixiaoer);
      const accountId = getPrimaryDouyinAccountId();
      const result = await publisher.resolveDouyinMusic(accountId, config.defaultMusic || null);
      return sendJson(res, {
        success: true,
        hasDefaultMusic: !!config.defaultMusic,
        configuredMusic: config.defaultMusic || null,
        valid: !!result.validDefault,
        fallbackUsed: !!result.fallbackUsed,
        fallbackKeyword: result.fallbackKeyword || null,
        activeMusic: result.music || null,
        message: result.message,
      });
    } catch (e) {
      return sendJson(res, { success: false, error: e.message }, e.statusCode || 500);
    }
  }

  if (pathname === '/api/music/default') {
    if (req.method === 'GET') {
      return sendJson(res, {
        success: true,
        music: config.defaultMusic || null
      });
    }

    if (req.method === 'POST') {
      readBody(req).then(async (body) => {
        try {
          const { music } = JSON.parse(body);
          if (!music || !music.id || !music.text) {
            return sendJson(res, { success: false, error: '音乐数据格式错误' }, 400);
          }

          config.defaultMusic = music;
          saveConfig();

          sendJson(res, { success: true, message: '默认配乐已保存' });
        } catch (e) {
          sendJson(res, { success: false, error: e.message }, 500);
        }
      }).catch(e => sendJson(res, { success: false, error: e.message }, e.statusCode || 500));
      return;
    }

    if (req.method === 'DELETE') {
      delete config.defaultMusic;
      saveConfig();
      return sendJson(res, { success: true, message: '默认配乐已清除' });
    }
  }

  if (pathname === '/api/music/search' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      try {
        const { keyword } = JSON.parse(body);
        if (!keyword || keyword.trim().length === 0) {
          return sendJson(res, { success: false, error: '搜索关键词不能为空' }, 400);
        }

        await publisher.ensureLogin(config.yixiaoer);
        const accountId = getPrimaryDouyinAccountId();
        const music = await publisher.searchMusicByAccount(accountId, keyword.trim());

        sendJson(res, {
          success: true,
          music: music || [],
          keyword: keyword.trim()
        });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
    }).catch(e => sendJson(res, { success: false, error: e.message }, e.statusCode || 500));
    return;
  }

  if (pathname === '/api/music/categories' && req.method === 'GET') {
    try {
      ensureYixiaoerConfigReady();
      await publisher.ensureLogin(config.yixiaoer);
      const accountId = getPrimaryDouyinAccountId();
      const categories = await publisher.getMusicCategories(accountId);
      return sendJson(res, {
        success: true,
        categories: categories || [],
      });
    } catch (e) {
      return sendJson(res, { success: false, error: e.message }, e.statusCode || 500);
    }
  }

  if (pathname === '/api/music/library' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      try {
        const { keyword, nextPage, categoryId, categoryName } = body ? JSON.parse(body) : {};
        const normalizedKeyword = keyword ? String(keyword).trim() : '';
        await publisher.ensureLogin(config.yixiaoer);
        const accountId = getPrimaryDouyinAccountId();
        const result = await publisher.browseMusicByAccount(accountId, {
          keyword: normalizedKeyword || '热歌',
          nextPage,
          categoryId,
          categoryName,
        });

        sendJson(res, {
          success: true,
          music: result.list || [],
          nextPage: result.nextPage || null,
          categoryId: categoryId || null,
          categoryName: categoryName || null,
          keyword: normalizedKeyword || '热歌',
        });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
    }).catch(e => sendJson(res, { success: false, error: e.message }, e.statusCode || 500));
    return;
  }

  // ── AI 写作配置 ──────────────────────────────────────────────────────────
  if (pathname === '/api/config/ai-writing' && req.method === 'POST') {
    readBody(req).then((body) => {
      try {
        const data = JSON.parse(body || '{}');
        config.aiWriting = config.aiWriting || {};
        if (data.enabled !== undefined) config.aiWriting.enabled = Boolean(data.enabled);
        if (data.provider) config.aiWriting.provider = String(data.provider);
        if (data.apiBaseUrl !== undefined) config.aiWriting.apiBaseUrl = String(data.apiBaseUrl || '');
        if (data.apiKey && data.apiKey !== '******') config.aiWriting.apiKey = String(data.apiKey);
        if (data.model) config.aiWriting.model = String(data.model);
        saveConfig();
        return sendJson(res, { success: true, message: 'AI 写作配置已保存' });
      } catch (e) {
        return sendJson(res, { success: false, error: e.message }, 500);
      }
    }).catch(e => sendJson(res, { success: false, error: e.message }, 500));
    return;
  }

  // ── AI 写作：测试连接 ─────────────────────────────────────────────────────
  if (pathname === '/api/ai-writing/test' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      try {
        const data = JSON.parse(body || '{}');
        const aiConfig = {
          provider: data.provider || config.aiWriting?.provider || 'openai',
          apiBaseUrl: data.apiBaseUrl || config.aiWriting?.apiBaseUrl || '',
          apiKey: (data.apiKey && data.apiKey !== '******') ? data.apiKey : config.aiWriting?.apiKey || '',
          model: data.model || config.aiWriting?.model || 'gpt-4o-mini',
        };
        const result = await testConnection(aiConfig);
        return sendJson(res, { success: true, message: '连接成功', data: result });
      } catch (e) {
        return sendJson(res, { success: false, error: e.message }, 500);
      }
    }).catch(e => sendJson(res, { success: false, error: e.message }, 500));
    return;
  }

  // ── AI 写作：手动为单条记录生成内容 ──────────────────────────────────────
  if (pathname === '/api/ai-writing/generate' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      try {
        const { recordId } = JSON.parse(body || '{}');
        if (!recordId) return sendJson(res, { success: false, error: '缺少 recordId' }, 400);
        ensureFeishuConfigReady();
        const records = await feishu.getUnpublishedRecords();
        const raw = records.find(r => r.record_id === recordId);
        if (!raw) return sendJson(res, { success: false, error: '找不到该记录' }, 404);
        const record = feishu.parseRecord(raw);
        if (!record.topic) return sendJson(res, { success: false, error: '该记录"笔记主题"为空，无法生成' }, 400);
        if (!config.aiWriting?.apiKey) return sendJson(res, { success: false, error: 'AI 写作未配置 API Key' }, 400);
        const result = await generateContent(config.aiWriting, record);
        const tagsStr = Array.isArray(result.tags) ? result.tags.join('\n') : '';
        const aiFieldNames = await feishu.getTableFields().catch(() => []);
        const aiFieldSet = new Set(Array.isArray(aiFieldNames) ? aiFieldNames : []);
        const aiFields = {};
        if (!aiFieldSet.size || aiFieldSet.has('标题')) aiFields['标题'] = result.title;
        if (!aiFieldSet.size || aiFieldSet.has('正文')) aiFields['正文'] = result.description;
        if (!aiFieldSet.size || aiFieldSet.has('标签')) aiFields['标签'] = tagsStr;
        if (Object.keys(aiFields).length > 0) {
          await feishu.updateRecord(recordId, aiFields);
        }
        // 更新缓存，防止下轮自动扫描重复覆盖
        try {
          const cache = readAiWritingCache();
          cache[recordId] = { topic: record.topic, generatedAt: new Date().toISOString() };
          saveAiWritingCache(cache);
        } catch (_) { /* 缓存失败不影响主流程 */ }
        return sendJson(res, { success: true, message: 'AI 内容已生成并回写飞书', data: result });
      } catch (e) {
        return sendJson(res, { success: false, error: e.message }, 500);
      }
    }).catch(e => sendJson(res, { success: false, error: e.message }, 500));
    return;
  }

  // 404
  res.writeHead(404);
  res.end('Not Found');
});

server.on('close', () => {
  activeServerInfo = null;
  scheduler.stop();
});

function logStartup(port, host) {
  console.log(`\n🚀 知发已启动！`);
  console.log(`📡 访问地址: http://${host}:${port}`);
  console.log(`📁 配置文件: ${runtimePaths.configPath}`);
  console.log(`🗂 数据目录: ${runtimePaths.dataDir}`);
  if (storageState.config === 'migrated') {
    console.log(`♻️ 已从旧路径迁移配置: ${migrationSources.config || runtimePaths.legacyConfigPath}`);
  } else if (storageState.config === 'created') {
    console.log(`🆕 已生成空白配置模板，请先在页面或配置文件中完成接入信息`);
  } else if (storageState.config === 'corrupted') {
    console.warn(`⚠️ 配置文件损坏，已备份并以默认配置启动，请前往「设置」重新填写飞书接入信息`);
  }
  if (storageState.ledger === 'migrated') {
    console.log(`♻️ 已从旧路径迁移发布账本: ${migrationSources.ledger || runtimePaths.legacyLedgerPath}`);
  }
  console.log(`\n按 Ctrl+C 停止服务\n`);
}

function printStartError(err, port) {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ 端口 ${port} 已被占用，请先关闭之前的服务`);
    console.error(`   运行: lsof -ti:${port} | xargs kill -9\n`);
  } else {
    console.error(`\n❌ 启动失败: ${err.message}\n`);
  }
}

function normalizeServerAddress(address, fallbackHost) {
  if (!address || typeof address === 'string') {
    return {
      port: DEFAULT_PORT,
      host: fallbackHost,
    };
  }

  let host = address.address || fallbackHost;
  if (host === '::' || host === '0.0.0.0') {
    host = '127.0.0.1';
  }

  return {
    port: address.port,
    host,
  };
}

function startServer(options = {}) {
  if (server.listening) {
    return Promise.resolve(activeServerInfo || {
      ...normalizeServerAddress(server.address(), options.host || DEFAULT_HOST),
      server,
    });
  }

  const port = options.port ?? DEFAULT_PORT;
  const host = options.host || DEFAULT_HOST;
  const exitOnError = options.exitOnError === true;
  const silent = options.silent === true;

  return new Promise((resolve, reject) => {
    const handleError = (err) => {
      cleanup();
      if (!silent) {
        printStartError(err, port);
      }
      if (exitOnError) {
        process.exit(1);
        return;
      }
      reject(err);
    };

    const handleListening = () => {
      cleanup();
      const info = normalizeServerAddress(server.address(), host);
      activeServerInfo = { ...info, server };
      if (!silent) {
        logStartup(info.port, info.host);
      }
      resolve(activeServerInfo);
    };

    const cleanup = () => {
      server.off('error', handleError);
      server.off('listening', handleListening);
    };

    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(port, host);
  });
}

function stopServer() {
  for (const res of sseClients) {
    try { res.end(); } catch (_) {}
  }
  sseClients.clear();

  if (!server.listening) {
    activeServerInfo = null;
    scheduler.stop();
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) return reject(err);
      activeServerInfo = null;
      resolve();
    });
  });
}

function getServerState() {
  return {
    runtimePaths: getPublicRuntimePaths(),
    storageState,
    configState: getConfigState(),
    server: activeServerInfo,
  };
}

module.exports = {
  startServer,
  stopServer,
  getServerState,
  scheduler,
  config,
};

if (require.main === module) {
  startServer({
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    exitOnError: true,
  }).catch(() => {});
}
