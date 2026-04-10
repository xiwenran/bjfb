const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIRECTORY_NAME = 'Zhifa';
const LEGACY_APP_DIRECTORY_NAMES = ['NotePublisher'];
const WORKSPACE_ROOT = path.join(__dirname, '..');
const LEGACY_CONFIG_PATH = path.join(WORKSPACE_ROOT, 'config.json');
const LEGACY_LEDGER_PATH = path.join(WORKSPACE_ROOT, 'publish-ledger.json');

const DEFAULT_CONFIG = {
  feishu: {
    appId: '',
    appSecret: '',
    wikiUrl: '',
    appToken: '',
    tableId: '',
  },
  yixiaoer: {
    username: '',
    password: '',
    teamId: '',
    apiKey: '',
    clientId: '',
  },
  bitbrowser: {
    apiBaseUrl: 'http://127.0.0.1:54345',
    publishUrl: 'https://creator.xiaohongshu.com/publish/publish',
    xiaohongshu: {},
  },
  accountMapping: {
    xiaohongshu: {},
    douyin: {},
  },
  schedule: {
    periods: [
      {
        startTime: '06:00',
        endTime: '08:00',
        intervalMinutes: 30,
      },
    ],
  },
  rules: {
    douyinMaxTags: 5,
    titleMaxLength: 50,
    descMaxLength: 2000,
    imagesSortByFilename: true,
    failOnInvalidAccount: true,
    failOnInvalidAccountAction: 'markFailedInFeishu',
  },
  defaultMusic: null,
  yixiaoerAccountCache: {
    xiaohongshu: {},
    douyin: {},
  },
  aiWriting: {
    enabled: false,
    provider: 'openai',
    apiBaseUrl: '',
    apiKey: '',
    model: 'gpt-4o-mini',
  },
};

function cloneDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function deepMerge(target, source) {
  if (!isPlainObject(source)) return target;

  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      target[key] = value.slice();
      continue;
    }

    if (isPlainObject(value)) {
      const base = isPlainObject(target[key]) ? target[key] : {};
      target[key] = deepMerge(base, value);
      continue;
    }

    if (value !== undefined) {
      target[key] = value;
    }
  }

  return target;
}

function resolveConfigBaseDir() {
  if (process.env.NOTE_PUBLISHER_CONFIG_HOME) {
    return path.resolve(process.env.NOTE_PUBLISHER_CONFIG_HOME);
  }

  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }

  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function resolveDataBaseDir() {
  if (process.env.NOTE_PUBLISHER_DATA_HOME) {
    return path.resolve(process.env.NOTE_PUBLISHER_DATA_HOME);
  }

  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA
      || process.env.APPDATA
      || path.join(os.homedir(), 'AppData', 'Local');
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches');
  }

  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
}

function getRuntimePaths() {
  const configBaseDir = resolveConfigBaseDir();
  const dataBaseDir = resolveDataBaseDir();
  const configDir = process.env.NOTE_PUBLISHER_CONFIG_DIR
    ? path.resolve(process.env.NOTE_PUBLISHER_CONFIG_DIR)
    : path.join(configBaseDir, APP_DIRECTORY_NAME);
  const dataDir = process.env.NOTE_PUBLISHER_DATA_DIR
    ? path.resolve(process.env.NOTE_PUBLISHER_DATA_DIR)
    : path.join(dataBaseDir, APP_DIRECTORY_NAME);

  return {
    appName: APP_DIRECTORY_NAME,
    workspaceRoot: WORKSPACE_ROOT,
    configDir,
    configPath: path.join(configDir, 'config.json'),
    dataDir,
    cacheDir: path.join(dataDir, 'cache'),
    tempDir: path.join(dataDir, 'tmp'),
    logsDir: path.join(dataDir, 'logs'),
    ledgerPath: path.join(dataDir, 'publish-ledger.json'),
    historyPath: path.join(dataDir, 'publish-history.json'),
    aiWritingCachePath: path.join(dataDir, 'ai-writing-cache.json'),
    legacyConfigPath: LEGACY_CONFIG_PATH,
    legacyLedgerPath: LEGACY_LEDGER_PATH,
    legacyNamedConfigPaths: LEGACY_APP_DIRECTORY_NAMES.map((name) => path.join(configBaseDir, name, 'config.json')),
    legacyNamedLedgerPaths: LEGACY_APP_DIRECTORY_NAMES.map((name) => path.join(dataBaseDir, name, 'publish-ledger.json')),
  };
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureRuntimeDirs(paths = getRuntimePaths()) {
  ensureDir(paths.configDir);
  ensureDir(paths.dataDir);
  ensureDir(paths.cacheDir);
  ensureDir(paths.tempDir);
  ensureDir(paths.logsDir);
}

function readJsonFile(filePath, fallback = null, options = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    if (options.throwOnError && fs.existsSync(filePath)) {
      throw new Error(`读取 JSON 失败: ${filePath} (${error.message})`);
    }
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function normalizeConfig(config = {}) {
  return deepMerge(cloneDefaultConfig(), config);
}

function ensureConfigFile(paths = getRuntimePaths()) {
  if (fs.existsSync(paths.configPath)) {
    return {
      state: 'existing',
      config: normalizeConfig(readJsonFile(paths.configPath, {}, { throwOnError: true })),
    };
  }

  if (fs.existsSync(paths.legacyConfigPath)) {
    return {
      state: 'migrated',
      config: normalizeConfig(readJsonFile(paths.legacyConfigPath, {}, { throwOnError: true })),
    };
  }

  for (const legacyPath of paths.legacyNamedConfigPaths || []) {
    if (fs.existsSync(legacyPath)) {
      return {
        state: 'migrated',
        config: normalizeConfig(readJsonFile(legacyPath, {}, { throwOnError: true })),
        sourcePath: legacyPath,
      };
    }
  }

  return {
    state: 'created',
    config: cloneDefaultConfig(),
  };
}

function ensureLedgerFile(paths = getRuntimePaths()) {
  if (fs.existsSync(paths.ledgerPath)) {
    return { state: 'existing', ledger: readJsonFile(paths.ledgerPath, {}) || {} };
  }

  if (fs.existsSync(paths.legacyLedgerPath)) {
    return { state: 'migrated', ledger: readJsonFile(paths.legacyLedgerPath, {}) || {} };
  }

  for (const legacyPath of paths.legacyNamedLedgerPaths || []) {
    if (fs.existsSync(legacyPath)) {
      return {
        state: 'migrated',
        ledger: readJsonFile(legacyPath, {}) || {},
        sourcePath: legacyPath,
      };
    }
  }

  return { state: 'created', ledger: {} };
}

function initializeAppStorage() {
  const paths = getRuntimePaths();
  ensureRuntimeDirs(paths);

  const configResult = ensureConfigFile(paths);
  const config = normalizeConfig(configResult.config);
  writeJsonFile(paths.configPath, config);

  const ledgerResult = ensureLedgerFile(paths);
  writeJsonFile(paths.ledgerPath, ledgerResult.ledger);

  return {
    config,
    paths,
    state: {
      config: configResult.state,
      ledger: ledgerResult.state,
    },
    migrationSources: {
      config: configResult.sourcePath || null,
      ledger: ledgerResult.sourcePath || null,
    },
  };
}

function loadConfig() {
  return initializeAppStorage().config;
}

function saveConfig(config) {
  const paths = getRuntimePaths();
  ensureRuntimeDirs(paths);
  const normalized = normalizeConfig(config);
  writeJsonFile(paths.configPath, normalized);
  return normalized;
}

function readLedger() {
  const { paths } = initializeAppStorage();
  return readJsonFile(paths.ledgerPath, {}) || {};
}

function saveLedger(data) {
  const paths = getRuntimePaths();
  ensureRuntimeDirs(paths);
  // 原子写：先写 .tmp 再 rename，与 saveHistory 对称。
  // 历史教训（2026-04-09 Codex 审计）：原本 saveLedger 是直接 writeFileSync，
  // saveHistory 是 tmp+rename，两者写顺序为 history 先 / ledger 后。
  // 进程在两次写之间被强杀（或 ledger 写到一半被杀），会出现：
  //   - 血统账本说"已发"，本地 ledger 没拦截 → 下一轮重发风险
  //   - ledger 文件残缺 JSON → 下次启动 loadPublishedLedger() fail-closed，整个服务起不来
  const tmp = `${paths.ledgerPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data || {}, null, 2), 'utf-8');
  fs.renameSync(tmp, paths.ledgerPath);
}

function readHistory() {
  const { paths } = initializeAppStorage();
  return readJsonFile(paths.historyPath, {}) || {};
}

function saveHistory(data) {
  const paths = getRuntimePaths();
  ensureRuntimeDirs(paths);
  // 原子写：先写 .tmp 再 rename，避免进程被强杀时损坏血统账本
  const tmp = `${paths.historyPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data || {}, null, 2), 'utf-8');
  fs.renameSync(tmp, paths.historyPath);
}

function getHistoryPath() {
  return getRuntimePaths().historyPath;
}

function readAiWritingCache() {
  const paths = getRuntimePaths();
  return readJsonFile(paths.aiWritingCachePath, {}) || {};
}

function saveAiWritingCache(data) {
  const paths = getRuntimePaths();
  ensureRuntimeDirs(paths);
  const tmp = `${paths.aiWritingCachePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data || {}, null, 2), 'utf-8');
  fs.renameSync(tmp, paths.aiWritingCachePath);
}

function getRecordTempDir(recordId) {
  const paths = getRuntimePaths();
  const safeRecordId = String(recordId || 'unknown').replace(/[\\/:*?"<>|]/g, '_');
  return path.join(paths.tempDir, 'yixiaoer-publish', safeRecordId);
}

function isFeishuConfigured(config = {}) {
  const feishu = config.feishu || {};
  return Boolean(feishu.appId && feishu.appSecret && feishu.appToken && feishu.tableId);
}

function isYixiaoerConfigured(config = {}) {
  const yixiaoer = config.yixiaoer || {};
  return Boolean(yixiaoer.apiKey && yixiaoer.teamId);
}

module.exports = {
  APP_DIRECTORY_NAME,
  DEFAULT_CONFIG,
  getRuntimePaths,
  initializeAppStorage,
  loadConfig,
  saveConfig,
  readLedger,
  saveLedger,
  readHistory,
  saveHistory,
  getHistoryPath,
  getRecordTempDir,
  isFeishuConfigured,
  isYixiaoerConfigured,
  normalizeConfig,
  readAiWritingCache,
  saveAiWritingCache,
};
