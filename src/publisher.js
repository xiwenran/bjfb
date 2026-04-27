const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const { publishToXiaohongshuViaBitBrowser } = require('./bitbrowser-xhs.js');
const { loadConfig, readLedger, saveLedger, readHistory, saveHistory, getHistoryPath, getRuntimePaths } = require('./config-store.js');
const { mapWithConcurrency } = require('./async-utils.js');
const {
  normalizePublishedEntry,
  createSubmittedEntry,
  markEntryObservedPublished,
  shouldKeepEntryForPendingStatus,
} = require('./publish-guard.js');
const DEFAULT_API_BASE_URL = 'https://www.yixiaoer.cn/api';
const DEFAULT_PENDING_STATUS_GUARD_MS = 2 * 60 * 1000;
// 链路 C1 防御：发布前/发布失败后查询蚁小二 /taskSets 的"最近窗口"（小时）
const C1_DEDUP_WINDOW_HOURS = 12;
const PLATFORM_RULES = {
  DouYin: { code: 'DouYin', name: '抖音', supportedTypes: ['video', 'imageText', 'article'] },
  XiaoHongShu: { code: 'XiaoHongShu', name: '小红书', supportedTypes: ['video', 'imageText'] },
};

function getProjectConfig() {
  return loadConfig();
}

function normalizeAccountAlias(value) {
  return String(value || '').trim();
}

function collectAccountAliases(account = {}) {
  const candidates = [
    account.platformAccountName,
    account.accountName,
    account.name,
    account.nick,
    account.nickname,
    account.nickName,
    account.userName,
    account.displayName,
    account.remark,
    account.remarkName,
    account.memo,
    account.platformAccountNickname,
    account.platformAccountRemark,
    account.platformAccountAlias,
    account.alias,
  ];

  const aliases = [];
  const seen = new Set();
  for (const item of candidates) {
    const text = normalizeAccountAlias(item);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(text);
  }
  return aliases;
}

let loginDone = false;
let authSignature = null;
let activeYixiaoerConfig = null;
let cachedHttpClient = null;
let cachedHttpClientSignature = null;
let cachedValidAccountIds = null;
let cachedValidAccountIdsSignature = null;
let cachedValidAccountIdsAt = 0;
const ACCOUNT_VALIDATION_CACHE_TTL_MS = 60 * 1000;

function resetRuntimeState() {
  loginDone = false;
  authSignature = null;
  activeYixiaoerConfig = null;
  cachedHttpClient = null;
  cachedHttpClientSignature = null;
  cachedValidAccountIds = null;
  cachedValidAccountIdsSignature = null;
  cachedValidAccountIdsAt = 0;
}

function getYixiaoerConfig(config) {
  return config?.yixiaoer || config || {};
}

function getApiSignature(config) {
  const yixiaoerConfig = getYixiaoerConfig(config);
  return [
    yixiaoerConfig.baseUrl || DEFAULT_API_BASE_URL,
    yixiaoerConfig.apiKey || '',
    yixiaoerConfig.teamId || '',
    yixiaoerConfig.clientId || '',
  ].join(':');
}

function getActiveYixiaoerConfig() {
  if (activeYixiaoerConfig) return activeYixiaoerConfig;
  return getProjectConfig().yixiaoer || {};
}

function isPendingStatus(status) {
  return status === '待发布';
}

function createHttpClient(config) {
  const yixiaoerConfig = getYixiaoerConfig(config);
  const signature = getApiSignature(yixiaoerConfig);

  if (cachedHttpClient && cachedHttpClientSignature === signature) {
    return cachedHttpClient;
  }

  const client = axios.create({
    baseURL: yixiaoerConfig.baseUrl || DEFAULT_API_BASE_URL,
    // 链路 C1 防御：30s → 90s。慢网络/Mac 唤醒后的网络栈恢复需要更长容错。
    timeout: 90000,
    headers: {
      'Content-Type': 'application/json',
      'x-client': 'openclaw',
      Authorization: yixiaoerConfig.apiKey,
    },
  });

  cachedHttpClient = client;
  cachedHttpClientSignature = signature;
  return client;
}

async function requestApi(config, method, endpoint, data) {
  const client = createHttpClient(config);
  try {
    const response = await client.request({
      method,
      url: endpoint,
      params: method === 'GET' ? data : undefined,
      data: method === 'GET' ? undefined : data,
    });
    return response.data?.data !== undefined ? response.data.data : response.data;
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    const err = new Error(`蚁小二API错误: ${message}`);
    err.response = error.response;
    throw err;
  }
}

// 自动降级：先用新路径，404 时降级到旧路径
async function requestApiWithFallback(config, method, primaryPath, fallbackPath, params) {
  try {
    return await requestApi(config, method, primaryPath, params);
  } catch (e) {
    if (e?.response?.status === 404) {
      console.warn(`⚠️ ${primaryPath} 返回 404，降级到 ${fallbackPath}`);
      return await requestApi(config, method, fallbackPath, params);
    }
    throw e;
  }
}

async function getTeams(config) {
  const result = await requestApi(config, 'GET', '/teams');
  return result?.data || result || [];
}

async function getAccounts(config, params = {}) {
  const result = await requestApiWithFallback(config, 'GET', '/v2/platform/accounts', '/platform-accounts', {
    page: 1,
    size: 200,
    ...params,
  });
  return {
    data: result?.data || [],
    totalSize: result?.totalSize || 0,
    page: result?.page || params.page || 1,
    size: result?.size || params.size || 200,
  };
}

async function getAllAccounts(config, params = {}) {
  const pageSize = Math.min(Number(params.size) || 200, 200);
  let page = Number(params.page) || 1;
  const items = [];

  while (true) {
    const result = await getAccounts(config, {
      ...params,
      page,
      size: pageSize,
    });

    const currentItems = result.data || [];
    items.push(...currentItems);

    if (currentItems.length < pageSize) break;
    if (result.totalSize && items.length >= result.totalSize) break;

    page += 1;
  }

  return items;
}

async function getPublishRecordsApi(config, params = {}) {
  const result = await requestApiWithFallback(config, 'GET', '/v2/taskSets', '/taskSets', {
    page: params.page || 1,
    size: params.size || 20,
  });
  return {
    data: result?.data || [],
    totalSize: result?.totalSize || 0,
    page: result?.page || params.page || 1,
    size: result?.size || params.size || 20,
  };
}

async function getUploadUrlApi(config, fileName, fileSize, contentType) {
  // 只发 fileName/fileSize，由服务端生成唯一 fileKey 返回。
  // 历史教训（2026-04-09）：曾把 fileKey: fileName 一起发过去，蚁小二服务端把客户端传来的
  // 文件名当作 OSS 全局 key，多条记录里同名图片（"1.png"/"封面.png"）互相覆盖，
  // 最终发出去的 5 条笔记内容全是最后一次上传的图。该字段禁止从客户端覆盖。
  const result = await requestApi(config, 'GET', '/storages/cloud-publish/upload-url', {
    fileName,
    fileSize,
    contentType,
  });
  return {
    uploadUrl: result?.serviceUrl || result?.uploadUrl || result?.data?.serviceUrl,
    fileKey: result?.key || result?.fileKey || result?.data?.key,
  };
}

async function getAccountMusicApi(config, params) {
  const { platformAccountId, ...query } = params;
  return requestApi(config, 'GET', `/platform-accounts/${platformAccountId}/music`, query);
}

async function getAccountMusicCategoryApi(config, platformAccountId) {
  return requestApi(config, 'GET', `/platform-accounts/${platformAccountId}/music/category`);
}

async function getAccountCategoriesApi(config, platformAccountId, publishType = 'imageText') {
  try {
    return await requestApi(config, 'GET',
      `/platform-accounts/${platformAccountId}/categories`,
      { publishType }
    );
  } catch (e) {
    if (e?.response?.status === 404) {
      console.warn(`⚠️ /categories 返回 404，降级到旧版 /topics 接口`);
      return await requestApi(config, 'GET',
        `/platform-accounts/${platformAccountId}/topics`,
        { keyWord: '' }
      );
    }
    throw e;
  }
}
// 向后兼容别名
const getAccountTopicsApi = getAccountCategoriesApi;

async function publishTaskApi(config, payload) {
  return requestApi(config, 'POST', '/taskSets/v2', payload);
}

function normalizePlatform(input) {
  if (PLATFORM_RULES[input]) return input;
  const found = Object.values(PLATFORM_RULES).find(item => item.name === input);
  return found ? found.code : null;
}

function normalizePublishType(input) {
  if (input === 'image') return 'imageText';
  if (input === 'video' || input === 'article' || input === 'imageText') return input;
  return null;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttr(text) {
  return escapeHtml(text).replace(/`/g, '&#96;');
}

function buildTopicRawAttr(topic) {
  if (!topic?.raw || !topic?.yixiaoerId || !topic?.yixiaoerName) return null;
  return JSON.stringify({
    yixiaoerId: topic.yixiaoerId,
    yixiaoerName: topic.yixiaoerName,
    raw: topic.raw,
  });
}

function selectBestTopic(tag, topics = []) {
  const normalizedTag = String(tag || '').trim().toLowerCase();
  if (!normalizedTag) return null;

  const normalizeTopicName = topic => String(
    topic?.yixiaoerName ||
    topic?.raw?.name ||
    topic?.raw?.topic ||
    topic?.raw?.cha_name ||
    ''
  ).trim().toLowerCase();

  const exact = topics.find(topic =>
    normalizeTopicName(topic) === normalizedTag
  );
  if (exact) return exact;

  const nameContains = topics.find(topic =>
    normalizeTopicName(topic).includes(normalizedTag) || normalizedTag.includes(normalizeTopicName(topic))
  );
  if (nameContains) return nameContains;

  return null;
}

async function resolveTopicsForPlatform(config, platformName, platformAccountId, tags = []) {
  const selectedTags = normalizeTags(tags);
  if (!platformAccountId || selectedTags.length === 0) return [];
  if (platformName !== '小红书' && platformName !== '抖音') return [];

  const resolvedTopics = [];

  for (const tag of selectedTags) {
    try {
      const result = await getAccountTopicsApi(config, platformAccountId, tag);
      const topics = result?.dataList || result?.data?.dataList || [];
      const matchedTopic = selectBestTopic(tag, topics);
      if (matchedTopic) {
        resolvedTopics.push(matchedTopic);
      }
    } catch (error) {
      console.warn(`⚠️ ${platformName}话题搜索失败(${tag}): ${error.message}`);
    }
  }

  return resolvedTopics;
}

function buildRichTopicDescription(description, tags = [], topics = []) {
  const paragraphs = String(description || '')
    .split(/\r?\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => `<p>${escapeHtml(line)}</p>`);

  const topicTags = normalizeTags(tags);
  if (topicTags.length > 0) {
    const topicMap = new Map(
      (topics || []).map(topic => [String(topic?.yixiaoerName || '').trim().toLowerCase(), topic])
    );
    const topicHtml = topicTags
      .map(tag => {
        const topic = topicMap.get(tag.toLowerCase());
        const rawAttr = buildTopicRawAttr(topic);
        const rawSegment = rawAttr ? ` raw='${escapeHtmlAttr(rawAttr)}'` : '';
        return `<topic text='${escapeHtmlAttr(tag)}'${rawSegment}>#${escapeHtml(tag)}</topic>`;
      })
      .join(' ');
    paragraphs.push(`<p>${topicHtml}</p>`);
  }

  return paragraphs.join('') || '<p></p>';
}

function buildContentPublishForm(platformName, publishType, params) {
  // covers 只视频/文章需要;图文(imageText)按蚁小二 v1.6 官方文档不应该有此字段
  const form = {
    formType: 'task',
  };
  if (publishType === 'video' || publishType === 'article') {
    form.covers = [];
  }

  const normalizedDescription = params.normalizedDescription !== undefined
    ? params.normalizedDescription
    : params.description || '';

  if (publishType === 'video') {
    form.title = params.title || '';
    if (normalizedDescription) form.description = normalizedDescription;
    form.declaration = 0;
    form.tagType = '位置';
    form.visibleType = 0;
    form.allow_save = 1;
  } else if (publishType === 'imageText') {
    // 注:declaration / type / visibleType 三个字段在蚁小二 v1.6 官方
    // image-text/xiaohongshu.md & douyin.md 都没列出,理论上是非官方字段。
    // 但 zhifa 历史上一直带这三个字段发布且持续成功,删除它们没有反证支持。
    // 本次保留,仅顺便补齐 OldImage.format 与 contentPublishForm.images 两个
    // 文档明确要求的必填项。等真有反证(蚁小二明确拒收这些字段)再清理。
    form.title = params.title || '';
    if (normalizedDescription) form.description = normalizedDescription;
    form.declaration = 0;
    form.type = 0;
    form.visibleType = 0;
  } else if (publishType === 'article') {
    form.title = params.title || '';
    if (normalizedDescription) form.description = normalizedDescription;
    form.type = 0;
    form.visibleType = 0;
    form.verticalCovers = [];
    if (typeof params.createType === 'number') form.createType = params.createType;
    if (typeof params.pubType === 'number') form.pubType = params.pubType;
  }

  if (params.tags?.length && platformName !== '小红书' && platformName !== '抖音') {
    form.tags = params.tags;
  }

  if (params.music) {
    form.music = params.music;
  }

  return form;
}

async function uploadFileToOss(config, filePath) {
  const baseName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;

  // 兜底防御（2026-04-09 事故）：即便服务端也以客户端传入的文件名为 key，
  // 给每次上传加一段随机 namespace，确保跨记录、跨账号的同名文件不会互相覆盖。
  // 1/2^48 的碰撞概率对单次发布会话已经足够安全。
  const ext = path.extname(baseName);
  const nameOnly = baseName.slice(0, baseName.length - ext.length);
  const ns = crypto.randomBytes(6).toString('hex');
  const fileName = `${ns}_${nameOnly}${ext}`;

  let contentType = 'application/octet-stream';
  if (fileName.endsWith('.mp4')) contentType = 'video/mp4';
  else if (/\.(jpg|jpeg)$/i.test(fileName)) contentType = 'image/jpeg';
  else if (/\.png$/i.test(fileName)) contentType = 'image/png';
  else if (/\.gif$/i.test(fileName)) contentType = 'image/gif';

  const uploadResult = await getUploadUrlApi(config, fileName, fileSize, contentType);
  if (!uploadResult.uploadUrl || !uploadResult.fileKey) {
    throw new Error('获取资源直传地址失败');
  }

  const fileStream = fs.createReadStream(filePath);
  // 防止 ReadStream 的 EPIPE 在 axios reject 之前作为 uncaught exception 冒泡。
  // OSS 服务端因 403/400 关闭连接时，Node stream 层会先触发 EPIPE error 事件，
  // 若无 error 监听则升级为 uncaughtException（Electron 弹窗）。
  // axios 会通过 socket 路径独立 reject，这里只是防止 stream 层漏报。
  fileStream.on('error', () => {});
  await axios.put(uploadResult.uploadUrl, fileStream, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': fileSize,
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  return { key: uploadResult.fileKey, size: fileSize };
}

async function ensureLogin(config) {
  const yixiaoerConfig = getYixiaoerConfig(config);
  if (!yixiaoerConfig.apiKey) {
    throw new Error('未配置蚁小二官方 API Key');
  }

  const nextSignature = getApiSignature(yixiaoerConfig);

  if (loginDone && authSignature === nextSignature) return;

  const teams = await getTeams(yixiaoerConfig);
  const team = teams.find(t => t.id === yixiaoerConfig.teamId);
  if (!team) throw new Error('未找到指定团队');

  loginDone = true;
  authSignature = nextSignature;
  activeYixiaoerConfig = yixiaoerConfig;
  console.log(`✅ 蚁小二连接成功 (团队: ${team.name} / 官方开放API)`);
}

async function getAccountList(options = {}) {
  const yixiaoerConfig = getActiveYixiaoerConfig();
  const params = { page: 1, size: 200 };
  if (options.loginStatus !== undefined) {
    params.loginStatus = options.loginStatus;
  }
  return getAllAccounts(yixiaoerConfig, params);
}

async function getAccountAliasIndex(options = {}) {
  const accounts = await getAccountList(options);
  const index = new Map();

  for (const account of accounts) {
    const aliases = collectAccountAliases(account);
    for (const alias of aliases) {
      index.set(alias.toLowerCase(), {
        id: account.id,
        account,
        aliases,
      });
    }
  }

  return index;
}

async function validateAccount(platformAccountId) {
  const nextSignature = getApiSignature(getActiveYixiaoerConfig());
  const now = Date.now();
  if (
    !cachedValidAccountIds
    || cachedValidAccountIdsSignature !== nextSignature
    || now - cachedValidAccountIdsAt > ACCOUNT_VALIDATION_CACHE_TTL_MS
  ) {
    const accounts = await getAccountList({ loginStatus: 1 });
    cachedValidAccountIds = new Set(accounts.map(account => account.id).filter(Boolean));
    cachedValidAccountIdsSignature = nextSignature;
    cachedValidAccountIdsAt = now;
  }

  return cachedValidAccountIds.has(platformAccountId);
}

async function getPublishRecords(options = {}) {
  const yixiaoerConfig = getActiveYixiaoerConfig();
  const result = await getPublishRecordsApi(yixiaoerConfig, {
    page: options.page || 1,
    size: options.size || 50,
  });
  return result.data || [];
}

// 云发布轮询：根据 taskSetId 查询蚁小二任务的最终状态
// 返回 taskSetStatus 字符串，或 null（查不到 / 接口失败）
async function getTaskSetStatus(taskSetId) {
  if (!taskSetId) return null;
  const yixiaoerConfig = getActiveYixiaoerConfig();
  try {
    const result = await getPublishRecordsApi(yixiaoerConfig, { page: 1, size: 30 });
    const records = result?.data || [];
    const task = records.find(r =>
      String(r.id || '') === String(taskSetId) ||
      String(r.taskSetId || '') === String(taskSetId)
    );
    return task?.taskSetStatus || null;
  } catch (e) {
    console.warn(`⚠️ 查询 taskSetStatus(${taskSetId}) 失败: ${e.message}`);
    return null;
  }
}

function extractTaskMeta(responseData) {
  if (!responseData || typeof responseData !== 'object') return {};

  const candidates = [
    responseData.taskSetId,
    responseData.taskId,
    responseData.id,
    responseData.data?.taskSetId,
    responseData.data?.taskId,
    responseData.data?.id,
  ].filter(Boolean);

  return {
    taskId: candidates[0] || null,
    raw: responseData,
  };
}

async function searchMusic(platformAccountId, keyword) {
  return browseMusic(platformAccountId, { keyword });
}

async function browseMusic(platformAccountId, options = {}) {
  const yixiaoerConfig = getActiveYixiaoerConfig();
  const result = await getAccountMusicApi(yixiaoerConfig, {
    platformAccountId,
    keyWord: options.keyword || '',
    nextPage: options.nextPage,
    categoryId: options.categoryId,
    categoryName: options.categoryName,
  });
  const data = result.data || result || {};
  return {
    list: data.dataList || result.dataList || [],
    nextPage: data.nextPage || null,
  };
}

// 通用音乐搜索（自动选择抖音账号）
async function searchMusicGeneral(keyword) {
  const accounts = await getAccountList();
  const douyinAccount = accounts.find(a => a.platformType === 0 || a.platformName === '抖音');

  if (!douyinAccount) {
    throw new Error('未找到可用的抖音账号来搜索音乐');
  }

  return await searchMusic(douyinAccount.id, keyword);
}

// 自动搜索配乐并返回 music 对象
async function autoSearchMusic(platformAccountId, keyword, exactName = null) {
  if (!keyword && !exactName) return null;
  try {
    // 优先使用精确歌曲名搜索
    const searchTerm = exactName || keyword;
    const isExact = !!exactName;

    console.log(`  🎵 搜索配乐: "${searchTerm}" ${isExact ? '(精确匹配)' : '(关键词匹配)'}`);

    const { list: musicList } = await browseMusic(platformAccountId, { keyword: searchTerm });
    if (musicList.length === 0) return null;

    let selectedMusic = musicList[0];  // 默认第一首

    // 如果是精确搜索，尝试找到完全匹配的歌曲
    if (isExact) {
      const exactMatch = musicList.find(music =>
        music.yixiaoerName === exactName ||
        music.yixiaoerName.includes(exactName) ||
        exactName.includes(music.yixiaoerName)
      );
      if (exactMatch) {
        selectedMusic = exactMatch;
        console.log(`  ✅ 精确匹配成功: ${selectedMusic.yixiaoerName}`);
      } else {
        console.log(`  ⚠️ 精确匹配失败，使用第一首: ${selectedMusic.yixiaoerName}`);
      }
    }

    return {
      id: selectedMusic.yixiaoerId,
      text: selectedMusic.yixiaoerName,
      raw: selectedMusic.raw,
    };
  } catch (e) {
    console.log(`  ⚠️ 音乐搜索失败: ${e.message}`);
    return null;
  }
}

async function getMusicCategories(platformAccountId) {
  const yixiaoerConfig = getActiveYixiaoerConfig();
  const result = await getAccountMusicCategoryApi(yixiaoerConfig, platformAccountId);
  return result.dataList || result.data?.dataList || [];
}

async function publishContent(params) {
  const yixiaoerConfig = {
    ...getActiveYixiaoerConfig(),
    ...getYixiaoerConfig(params),
    teamId: params.teamId || getActiveYixiaoerConfig().teamId,
  };
  const publishType = normalizePublishType(params.publishType || 'imageText');
  if (!publishType) {
    return { success: false, message: '不支持的发布类型' };
  }

  const platformCodes = [];
  const platformForms = {};
  let primaryPlatformName = '';
  for (const platformInput of params.platforms || []) {
    const platformCode = normalizePlatform(platformInput);
    if (!platformCode) {
      return { success: false, message: `不支持的平台: ${platformInput}` };
    }
    if (!PLATFORM_RULES[platformCode].supportedTypes.includes(publishType)) {
      return { success: false, message: `${platformInput}不支持${publishType}` };
    }
    platformCodes.push(platformCode);
    primaryPlatformName = primaryPlatformName || PLATFORM_RULES[platformCode].name;
    platformForms[PLATFORM_RULES[platformCode].name] = { formType: 'task' };
  }

  const normalizedDescription = (primaryPlatformName === '小红书' || primaryPlatformName === '抖音')
    ? buildRichTopicDescription(
      params.description || '',
      params.tags || [],
      await resolveTopicsForPlatform(yixiaoerConfig, primaryPlatformName, params.platformAccountId, params.tags || [])
    )
    : (params.description || '');

  const contentPublishForm = buildContentPublishForm(primaryPlatformName, publishType, {
    title: params.title,
    description: params.description || '',
    normalizedDescription,
    createType: params.createType,
    pubType: params.pubType,
    tags: params.tags,
    music: params.music,
  });

  const accountForm = {
    platformAccountId: params.platformAccountId,
    publishContentId: params.publishContentId,
    coverKey: params.coverKey,
    contentPublishForm,
    mediaId: '',
  };

  if (publishType === 'video' && params.videoPath) {
    if (params.videoPath.startsWith('http')) {
      accountForm.video = {
        path: params.videoPath,
        duration: params.videoDuration || 0,
        width: params.videoWidth || 1080,
        height: params.videoHeight || 1920,
        size: params.videoSize || 0,
      };
    } else {
      const videoInfo = await uploadFileToOss(yixiaoerConfig, params.videoPath);
      accountForm.video = {
        key: videoInfo.key,
        duration: params.videoDuration || 0,
        width: params.videoWidth || 1080,
        height: params.videoHeight || 1920,
        size: videoInfo.size,
      };
    }
  }

  if (params.coverPath) {
    if (params.coverPath.startsWith('http')) {
      accountForm.cover = {
        path: params.coverPath,
        width: params.coverWidth || 1080,
        height: params.coverHeight || 1920,
        size: params.coverSize || 0,
      };
    } else {
      const coverInfo = await uploadFileToOss(yixiaoerConfig, params.coverPath);
      accountForm.coverKey = coverInfo.key;
      accountForm.cover = {
        key: coverInfo.key,
        width: params.coverWidth || 1080,
        height: params.coverHeight || 1920,
        size: coverInfo.size,
      };
    }
  }

  if (publishType === 'imageText' && params.imagePaths?.length) {
    // 蚁小二 v1.6 OldImage 必填字段:width / height / size / key / format
    // 官方文档列举的 format 值:jpg / png / jpeg / gif
    // whitelist 处理:只接受文档列出的 4 种,其他(bak / heic / webp / 无扩展名 URL 等)统一归 jpg
    const ALLOWED_FORMATS = new Set(['jpg', 'png', 'gif']);
    const inferFormat = (p) => {
      const ext = path.extname(p || '').slice(1).toLowerCase();
      if (!ext) return 'jpg';
      if (ext === 'jpeg') return 'jpg';
      if (ALLOWED_FORMATS.has(ext)) return ext;
      return 'jpg'; // 未识别格式兜底,避免 OldImage.format 给蚁小二一个未知值
    };
    const uploadConcurrency = Math.max(1, Number(params.rules?.uploadConcurrency) || 3);
    const imageObjects = await mapWithConcurrency(params.imagePaths, uploadConcurrency, async (imagePath) => {
      if (imagePath.startsWith('http')) {
        return {
          path: imagePath,
          width: params.coverWidth || 1080,
          height: params.coverHeight || 1920,
          size: params.coverSize || 0,
          format: inferFormat(imagePath),
        };
      }

      const imageInfo = await uploadFileToOss(yixiaoerConfig, imagePath);
      return {
        key: imageInfo.key,
        width: params.coverWidth || 1080,
        height: params.coverHeight || 1920,
        size: imageInfo.size,
        format: inferFormat(imagePath),
      };
    });

    // 外层保留(顶层 accountForm 由 index.md 1.4 节定义为必填)
    accountForm.images = imageObjects;
    // 同时挂到 contentPublishForm.images(平台级,各平台 .md 文档定义为必填)
    contentPublishForm.images = imageObjects;
    if (!accountForm.coverKey && imageObjects.length > 0) {
      const first = imageObjects[0];
      if (first.key) accountForm.coverKey = first.key;
      accountForm.cover = {
        key: first.key,
        path: first.path,
        width: first.width,
        height: first.height,
        size: first.size,
        ...(first.format ? { format: first.format } : {}),
      };
    }
  }

  const platformNames = platformCodes.map(code => PLATFORM_RULES[code].name);
  const finalPublishChannel = params.clientId ? 'local' : (params.publishChannel || 'cloud');
  const payload = {
    clientId: finalPublishChannel === 'cloud' ? null : (params.clientId || null),
    platforms: platformNames,
    publishType,
    publishChannel: finalPublishChannel,
    coverKey: accountForm.coverKey || '',
    proxyId: params.proxyId,
    publishArgs: {
      accountForms: [accountForm],
      platformForms,
      content: normalizedDescription || undefined,
    },
  };

  // 诊断日志:写到 ~/Library/Caches/Zhifa/logs/publisher-debug.log
  // 自动封顶:文件超过 10MB 时自动清空(rotate 太复杂,这里走简单粗暴的 truncate),
  // 防止后台跑久了塞满磁盘
  const DEBUG_LOG_MAX_BYTES = 10 * 1024 * 1024;
  const debugLogFile = (() => {
    try {
      const paths = getRuntimePaths();
      if (!fs.existsSync(paths.logsDir)) fs.mkdirSync(paths.logsDir, { recursive: true });
      return path.join(paths.logsDir, 'publisher-debug.log');
    } catch (e) {
      return null;
    }
  })();
  const writeDebugLog = (label, obj) => {
    if (!debugLogFile) return;
    try {
      // 写之前检查 size,超过 10MB 直接清空重来
      if (fs.existsSync(debugLogFile)) {
        const stat = fs.statSync(debugLogFile);
        if (stat.size > DEBUG_LOG_MAX_BYTES) {
          fs.writeFileSync(debugLogFile, `===== [${new Date().toISOString()}] 日志超过 ${Math.round(DEBUG_LOG_MAX_BYTES / 1024 / 1024)}MB,已自动清空 =====\n`, 'utf-8');
        }
      }
      const line = `\n===== [${new Date().toISOString()}] ${label} =====\n${typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)}\n`;
      fs.appendFileSync(debugLogFile, line, 'utf-8');
    } catch (_) {}
  };

  writeDebugLog('蚁小二请求 payload 诊断 (shape)', {
    publishType,
    publishChannel: finalPublishChannel,
    platforms: platformNames,
    coverKey: payload.coverKey,
    accountFormShape: {
      hasOuterImages: Array.isArray(accountForm.images),
      outerImageCount: accountForm.images?.length || 0,
      cpfHasImages: Array.isArray(contentPublishForm.images),
      cpfImageCount: contentPublishForm.images?.length || 0,
      hasCover: !!accountForm.cover,
      contentPublishFormKeys: Object.keys(contentPublishForm),
      firstImageSample: accountForm.images?.[0] || null,
      coverSample: accountForm.cover || null,
    },
    rawAccountFormKeys: Object.keys(accountForm),
    rawPayloadKeys: Object.keys(payload),
  });
  writeDebugLog('完整 contentPublishForm', contentPublishForm);
  writeDebugLog('完整 accountForm (含全部 images)', accountForm);
  writeDebugLog('完整 payload (发往 /taskSets/v2)', payload);

  let data;
  try {
    data = await publishTaskApi(yixiaoerConfig, payload);
    writeDebugLog('蚁小二 API 成功响应', data);
  } catch (apiErr) {
    writeDebugLog('蚁小二 API 失败响应', {
      message: apiErr?.message,
      stack: apiErr?.stack,
      response: apiErr?.response?.data,
      status: apiErr?.response?.status,
    });
    throw apiErr;
  }
  const finalized = finalPublishChannel !== 'cloud';
  return {
    success: true,
    finalized,
    message: `✅ ${(finalPublishChannel === 'local' ? '本机发布' : '云发布')}任务已提交到 ${platformNames.join(', ')}`,
    data,
  };
}

// 原子写：先写 .tmp 再 rename，避免进程被强杀时只写一半。
function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

// 已发布记录缓存（防止同一内容重复发到同一平台）
const publishedCache = new Map(); // key: "recordId:platform" → ledger entry

// 跨账号血统账本（永远只追加，不会被状态翻转清空）
// 结构：{ recordId: { 小红书: [{accountName, accountId, channel, at, taskId, contentHash}], 抖音: [...] } }
const publishHistoryCache = new Map();

function loadPublishedLedger() {
  try {
    const data = readLedger();
    for (const key of Object.keys(data || {})) {
      const entry = normalizePublishedEntry(data[key]);
      if (entry) publishedCache.set(key, entry);
    }
  } catch (e) {
    // 防重失效是不可接受的——宁可启动失败也不要静默继续
    const msg = `🚨 读取发布账本失败: ${e.message}。防重账本不可用，拒绝启动。`;
    console.error(msg);
    throw new Error(msg);
  }
}

function savePublishedLedger() {
  try {
    const data = Object.fromEntries(publishedCache.entries());
    saveLedger(data);
  } catch (e) {
    console.warn(`⚠️ 保存发布账本失败: ${e.message}`);
  }
}

function loadPublishHistory() {
  try {
    const data = readHistory();
    for (const recordId of Object.keys(data || {})) {
      publishHistoryCache.set(recordId, data[recordId] || {});
    }
  } catch (e) {
    const msg = `🚨 读取血统账本失败: ${e.message}。跨账号防护不可用，拒绝启动。`;
    console.error(msg);
    throw new Error(msg);
  }
}

// P0.5 内容指纹跨记录扫描：返回 history 中所有 recordId（≠ currentRecordId）下相同 contentHash 的发布记录
function findCrossRecordByContentHash(currentRecordId, platform, contentHash) {
  if (!contentHash) return null;
  for (const [otherRecordId, entry] of publishHistoryCache.entries()) {
    if (otherRecordId === currentRecordId) continue;
    const list = Array.isArray(entry?.[platform]) ? entry[platform] : [];
    const match = list.find(item => item?.contentHash === contentHash);
    if (match) {
      return {
        recordId: otherRecordId,
        accountName: match.accountName || '',
        accountId: match.accountId || null,
        at: match.at || null,
      };
    }
  }
  return null;
}

function savePublishHistory() {
  const data = Object.fromEntries(publishHistoryCache.entries());
  saveHistory(data);
}

function getPublishKey(recordId, platform) {
  return `${recordId}:${platform}`;
}

function getPublishedEntry(recordId, platform) {
  return publishedCache.get(getPublishKey(recordId, platform)) || null;
}

function isAlreadyPublished(recordId, platform) {
  return publishedCache.has(getPublishKey(recordId, platform));
}

function markAsPublished(recordId, platform, now = Date.now()) {
  publishedCache.set(getPublishKey(recordId, platform), createSubmittedEntry(now));
  savePublishedLedger();
}

function markAsObservedPublished(recordId, platform, now = Date.now()) {
  const key = getPublishKey(recordId, platform);
  const current = publishedCache.get(key);
  publishedCache.set(key, markEntryObservedPublished(current, now));
  savePublishedLedger();
}

function unmarkAsPublished(recordId, platform) {
  const key = getPublishKey(recordId, platform);
  if (!publishedCache.has(key)) return;
  publishedCache.delete(key);
  savePublishedLedger();
}

// 返回某条 record 在某个 platform 上历史发布过的所有账号名集合（去重，trim 后比较）
function getHistoryAccounts(recordId, platform) {
  const entry = publishHistoryCache.get(recordId);
  if (!entry || !Array.isArray(entry[platform])) return [];
  const names = new Set();
  for (const item of entry[platform]) {
    const name = String(item?.accountName || '').trim();
    if (name) names.add(name);
  }
  return [...names];
}

// 追加一条血统记录（永远只追加，不删除）
function appendHistory(recordId, platform, entry) {
  if (!recordId || !platform || !entry) return;
  const existing = publishHistoryCache.get(recordId) || {};
  const list = Array.isArray(existing[platform]) ? existing[platform] : [];
  list.push({
    accountName: String(entry.accountName || '').trim(),
    accountId: entry.accountId || null,
    channel: entry.channel || '蚁小二',
    at: entry.at || Date.now(),
    taskId: entry.taskId || null,
    contentHash: entry.contentHash || null,
  });
  existing[platform] = list;
  publishHistoryCache.set(recordId, existing);
  savePublishHistory();
}

function computeContentHash(record) {
  // 内容指纹：所有可被用户修改的字段都做 normalize 后再 hash，避免被尾部空格 / 顺序调换绕过
  const normalize = (s) => String(s || '').replace(/\s+/g, '').trim();
  const tokens = (record.attachments || [])
    .map(a => normalize(a?.file_token || a?.fileToken))
    .filter(Boolean)
    .sort(); // 排序消除顺序差异
  const text = [
    normalize(record.title),
    normalize(record.description),
    tokens.join(','),
  ].join('\n');
  return crypto.createHash('sha256').update(text).digest('hex');
}

// 链路 C1 防御：从蚁小二最近 30 条任务中查找近 N 小时内同 title + 同账号 的记录。
// 返回 { found, lookupError }：
//   - found: 命中的记录或 null
//   - lookupError: 查询本身失败时的错误信息（区分"查到没匹配" vs "接口失败"）
// 仅供 publishToPlatform 内部使用。
async function findRecentTaskByTitleAndAccount(yixiaoerConfig, platformName, title, accountId, accountName, hoursWindow = C1_DEDUP_WINDOW_HOURS) {
  if (!title) return { found: null, lookupError: null };
  // 重试机制：避免短暂网络抖动让 fail-closed 大规模误判
  let result;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      result = await getPublishRecordsApi(yixiaoerConfig, { page: 1, size: 30 });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, attempt * 1500));
      }
    }
  }
  if (lastErr) {
    const msg = lastErr?.message || 'unknown';
    console.warn(`⚠️ C1 预查重 (${platformName}/${accountName}) 接口调用失败 (3 次重试均失败): ${msg}`);
    return { found: null, lookupError: msg };
  }
  try {
    const since = Date.now() - hoursWindow * 60 * 60 * 1000;
    const records = result?.data || [];
    const normTitle = String(title).trim();
    const normAccountName = String(accountName || '').trim();
    const normAccountId = String(accountId || '').trim();
    const platformAliases = new Set([platformName]);
    const ruleKey = normalizePlatform(platformName);
    if (ruleKey && PLATFORM_RULES[ruleKey]?.name) platformAliases.add(PLATFORM_RULES[ruleKey].name);
    const found = records.find(item => {
      const itemTitle = item?.title ? String(item.title).trim() : '';
      // 标题匹配：trim 后严格相等。
      // 之前曾经放宽为前缀互含，但 codex 指出会让"前 20 字相同的不同笔记"误命中，回退到严格匹配。
      // 如果出现服务端截断的兼容性问题再单独打补丁，不要在这里放宽。
      const sameTitle = itemTitle && itemTitle === normTitle;
      if (!sameTitle) return false;
      const platforms = Array.isArray(item?.platforms) ? item.platforms : [];
      const samePlatform = platforms.length === 0 || platforms.some(p => platformAliases.has(p));
      if (!samePlatform) return false;
      const itemAccountId = String(item?.platformAccountId || '').trim();
      const itemNickName = String(item?.nickName || '').trim();
      const sameAccount = (normAccountId && itemAccountId === normAccountId)
        || (normAccountName && itemNickName === normAccountName);
      if (!sameAccount) return false;
      if (!item?.createdAt) return true;
      return new Date(item.createdAt).getTime() >= since;
    }) || null;
    return { found, lookupError: null };
  } catch (e) {
    const msg = e?.message || 'unknown';
    console.warn(`⚠️ C1 预查重 (${platformName}/${accountName}) 接口调用失败: ${msg}`);
    return { found: null, lookupError: msg };
  }
}

function normalizeTags(tags) {
  const seen = new Set();
  return (tags || [])
    .map(tag => String(tag || '').replace(/^#+/, '').trim())
    .filter(Boolean)
    .filter(tag => {
      const key = tag.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function scoreTags(tags, title) {
  return normalizeTags(tags).map(tag => {
    let score = 0;
    if (title && title.includes(tag)) score += 10;
    if (tag.length <= 4) score += 3;
    if (/[一二三四五六]下|语文|数学|英语|公开课|课件|教案|教学|课堂/.test(tag)) score += 5;
    return { tag, score };
  }).sort((a, b) => b.score - a.score);
}

function selectTopTags(tags, title, max) {
  return scoreTags(tags, title).slice(0, max).map(item => item.tag);
}

function selectTagsForPlatform(platformName, tags, title) {
  const cleanTags = normalizeTags(tags);
  if (cleanTags.length === 0) return [];

  if (platformName === '抖音') {
    return selectTopTags(cleanTags, title, 5);
  }

  if (platformName === '小红书') {
    return selectTopTags(cleanTags, title, 10);
  }

  return cleanTags;
}

function truncateTextByLimit(text, maxLength) {
  const normalized = String(text || '').trim();
  if (!maxLength || normalized.length <= maxLength) {
    return { text: normalized, truncated: false };
  }
  return {
    text: normalized.slice(0, maxLength),
    truncated: true,
  };
}

function resolveTitleForPlatform(platformName, title) {
  const limit = (platformName === '小红书' || platformName === '抖音') ? 20 : 50;
  return {
    ...truncateTextByLimit(title, limit),
    limit,
  };
}

async function validateMusicSelection(platformAccountId, music) {
  if (!music || !music.text) {
    return { valid: false, reason: '未设置默认配乐' };
  }

  const { list } = await browseMusic(platformAccountId, { keyword: music.text });
  const candidates = list || [];
  const exact = candidates.find(item =>
    item.yixiaoerId === music.id ||
    item.yixiaoerName === music.text ||
    item.yixiaoerName?.includes(music.text) ||
    music.text.includes(item.yixiaoerName || '')
  );

  if (!exact) {
    return { valid: false, reason: '当前默认配乐在官方音乐库中未命中' };
  }

  return {
    valid: true,
    music: {
      id: exact.yixiaoerId,
      text: exact.yixiaoerName,
      raw: exact.raw,
    }
  };
}

async function getFallbackMusic(platformAccountId) {
  const fallbackKeywords = ['纯音乐', '轻音乐', '治愈', '热门纯音乐', '热歌'];

  for (const keyword of fallbackKeywords) {
    const { list } = await browseMusic(platformAccountId, { keyword });
    if (list && list.length > 0) {
      const first = list[0];
      return {
        keyword,
        music: {
          id: first.yixiaoerId,
          text: first.yixiaoerName,
          raw: first.raw,
        }
      };
    }
  }

  return null;
}

async function resolveDouyinMusic(platformAccountId, music) {
  const validation = await validateMusicSelection(platformAccountId, music);
  if (validation.valid) {
    return {
      music: validation.music,
      source: music ? 'default' : 'none',
      validDefault: true,
      fallbackUsed: false,
      message: music ? `使用默认配乐: ${validation.music.text}` : '未设置默认配乐',
    };
  }

  const fallback = await getFallbackMusic(platformAccountId);
  if (fallback) {
    return {
      music: fallback.music,
      source: 'fallback',
      validDefault: false,
      fallbackUsed: true,
      fallbackKeyword: fallback.keyword,
      message: music
        ? `默认配乐失效，已自动回退到${fallback.keyword}: ${fallback.music.text}`
        : `未设置默认配乐，已自动使用${fallback.keyword}: ${fallback.music.text}`,
    };
  }

  return {
    music: null,
    source: 'none',
    validDefault: false,
    fallbackUsed: false,
    message: music ? '默认配乐不可用，且未找到可回退音乐' : '未设置默认配乐，且未找到可回退音乐',
  };
}

async function publishRecord(record, config, accountMapping, options = {}) {
  const results = [];
  const yixiaoerConfig = config.yixiaoer || config;
  const bitbrowserConfig = config.bitbrowser || {};
  const teamId = yixiaoerConfig.teamId;
  const accountAliasCache = config.yixiaoerAccountCache || {};
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const pendingStatusGuardMs = Math.max(
    0,
    Number(config.rules?.pendingStatusGuardMs) || DEFAULT_PENDING_STATUS_GUARD_MS
  );

  function isPublishableStatus(status) {
    return status === '待发布';
  }

  function resolveMappedAccountId(platformName, accountName) {
    const platformKey = platformName === '小红书' ? 'xiaohongshu' : 'douyin';
    const directId = accountMapping?.[platformKey]?.[accountName];
    if (directId) {
      return { accountId: directId, matchType: 'direct' };
    }

    const normalizedTarget = normalizeAccountAlias(accountName).toLowerCase();
    if (!normalizedTarget) {
      return { accountId: null, matchType: 'none' };
    }

    const cachedPlatform = accountAliasCache?.[platformKey] || {};
    for (const [mappedName, mappedId] of Object.entries(accountMapping?.[platformKey] || {})) {
      const aliases = [
        mappedName,
        ...(cachedPlatform?.[mappedId]?.aliases || []),
      ]
        .map(normalizeAccountAlias)
        .filter(Boolean);

      if (aliases.some(alias => alias.toLowerCase() === normalizedTarget)) {
        return { accountId: mappedId, matchType: 'alias' };
      }
    }

    return { accountId: null, matchType: 'none' };
  }

  const allowCrossAccount = options.allowCrossAccount === true;

  // 飞书平台状态是是否允许发布的唯一开关。
  // 只有精确等于”待发布”时，才会清除本地保护并允许进入发布流程。
  if (record.xiaohongshuStatus === '已发布') {
    markAsObservedPublished(record.recordId, '小红书');
  } else if (isPendingStatus(record.xiaohongshuStatus)) {
    const shouldKeep = shouldKeepEntryForPendingStatus(
      getPublishedEntry(record.recordId, '小红书'),
      Date.now(),
      pendingStatusGuardMs
    );
    if (!shouldKeep) {
      unmarkAsPublished(record.recordId, '小红书');
    }
  }
  if (record.douyinStatus === '已发布') {
    markAsObservedPublished(record.recordId, '抖音');
  } else if (isPendingStatus(record.douyinStatus)) {
    const shouldKeep = shouldKeepEntryForPendingStatus(
      getPublishedEntry(record.recordId, '抖音'),
      Date.now(),
      pendingStatusGuardMs
    );
    if (!shouldKeep) {
      unmarkAsPublished(record.recordId, '抖音');
    }
  }

  // P0 红线防御：跨账号血统硬锁 + 跨记录内容指纹软锁。
  // 一条 recordId 一旦在某个平台上发过任何一个账号，就永远不能发到历史集合外的另一个账号。
  // 此外：如果不同 recordId 但内容指纹完全一致（用户复制粘贴新建一条），也拦截掉。
  const recordContentHash = computeContentHash(record);
  function checkCrossAccountLock(platformName, currentAccountName) {
    if (allowCrossAccount) return null; // /api/force-republish 显式同账号重发会传 false
    // 1. 同 recordId 跨账号锁
    const history = getHistoryAccounts(record.recordId, platformName);
    if (history.length > 0) {
      const current = String(currentAccountName || '').trim();
      if (!history.includes(current)) {
        return {
          platform: platformName,
          account: currentAccountName,
          accountId: null,
          success: false,
          critical: true,
          crossAccount: true,
          historyAccounts: history,
          markFailed: true,
          error: `🚨 红线保护：此笔记已发布到账号 [${history.join(',')}]，拒绝发送到账号 [${currentAccountName}]`,
        };
      }
    }
    // 2. 跨记录内容指纹锁：防御”复制粘贴新建条目改账号”
    const dup = findCrossRecordByContentHash(record.recordId, platformName, recordContentHash);
    if (dup) {
      return {
        platform: platformName,
        account: currentAccountName,
        accountId: null,
        success: false,
        critical: true,
        crossAccount: true,
        crossRecordDuplicate: true,
        historyAccounts: [dup.accountName].filter(Boolean),
        duplicateRecordId: dup.recordId,
        markFailed: true,
        error: `🚨 红线保护：内容指纹与另一条记录 [recordId=${dup.recordId}, 账号=${dup.accountName || '?'}] 完全相同，拒绝重复发送到账号 [${currentAccountName}]`,
      };
    }
    return null;
  }

  // 发布到单个平台的通用函数
  async function publishToPlatform(platformName, accountName, accountId, extraOpts) {
    const xhsPublishChannel = record.xiaohongshuPublishChannel === '比特浏览器' ? '比特浏览器' : '蚁小二';
    const platformStatus = platformName === '小红书' ? record.xiaohongshuStatus : record.douyinStatus;

    if (!isPublishableStatus(platformStatus)) {
      return null;
    }

    // P0 跨账号硬锁
    const crossAccountReject = checkCrossAccountLock(platformName, accountName);
    if (crossAccountReject) {
      console.error(`  🚨 ${crossAccountReject.error}`);
      return crossAccountReject;
    }

    // 防重复：检查是否已在该平台发布过
    if (isAlreadyPublished(record.recordId, platformName)) {
      console.log(`  ⏭ 跳过${platformName}: "${record.title}" 已在该平台发布过`);
      return {
        platform: platformName,
        account: accountName,
        accountId,
        success: true,
        skipped: true,
        finalized: true,
      };
    }

    if (platformName === '小红书' && xhsPublishChannel === '比特浏览器') {
      const browserMapping = bitbrowserConfig.xiaohongshu || {};
      const browserId = browserMapping[accountName]?.browserId;
      if (!browserId) {
        return {
          platform: platformName,
          account: accountName,
          success: false,
          error: `未找到比特浏览器映射: ${accountName}`,
        };
      }

      try {
        const tags = selectTagsForPlatform(platformName, record.tags, record.title);
        const titleMeta = resolveTitleForPlatform(platformName, record.title);
        onProgress({
          stage: 'submitting',
          title: record.title,
          recordId: record.recordId,
          platform: platformName,
          account: accountName,
          detail: `正在通过比特浏览器发布到${platformName}(${accountName})`,
        });
        if (titleMeta.truncated) {
          console.log(`  ✂️ ${platformName}标题超限，已自动截断为 ${titleMeta.limit} 字`);
        }

        const result = await publishToXiaohongshuViaBitBrowser({
          ...record,
          title: titleMeta.text,
        }, {
          browserId,
          bitbrowserConfig,
          tags,
          onProgress,
        });

        // R6 修复：本地 ledger 不再在此处写入，由 scheduler 在飞书状态更新成功后统一写入。
        return {
          platform: platformName,
          account: accountName,
          accountId: browserId,
          success: result.success,
          error: result.success ? null : result.message,
          finalized: true,
          publishMode: '比特浏览器发布',
          taskMeta: result.taskMeta || null,
          titleMeta,
        };
      } catch (e) {
        return {
          platform: platformName,
          account: accountName,
          accountId: browserId,
          success: false,
          error: e.message,
        };
      }
    }

    if (!accountId) {
      return { platform: platformName, account: accountName, accountId, success: false,
        error: `未找到账号映射: ${accountName}` };
    }

    const isValid = await validateAccount(accountId);
    if (!isValid) {
      // 红线规则：账号失效不发到其他账号，标记失败
      return { platform: platformName, account: accountName, accountId, success: false,
        error: `账号失效或未授权: ${accountName}`, markFailed: true };
    }

    try {
      const tags = selectTagsForPlatform(platformName, record.tags, record.title);
      const titleMeta = resolveTitleForPlatform(platformName, record.title);

      // 链路 C1 防御：发布前预查重。
      // 在真正 POST 之前先查蚁小二最近 30 条任务，如果同 title + 同账号在最近 12h 内已存在，
      // 判定为"上次请求虽然客户端报错，但服务端已经接收并执行"，跳过本次提交。
      const preLookup = await findRecentTaskByTitleAndAccount(
        yixiaoerConfig, platformName, titleMeta.text, accountId, accountName
      );
      if (preLookup.lookupError) {
        // C1 预查重接口失败 → fail-closed：查不到就不敢发，宁可本次跳过也不冒重复发布的风险。
        // 逻辑：蚁小二没响应 → 不知道这条笔记最近有没有发过 → 不发。
        // 如果 /taskSets 接口路径有变（如迁移到 /v2/taskSets），需先修路径再上线。
        return {
          platform: platformName, account: accountName, accountId,
          success: false,
          c1LookupFailed: true,
          markFailed: true,
          error: `C1 预查重接口失败: ${preLookup.lookupError}。为防止重复发布，已暂缓本次提交，请检查蚁小二接口连通性后重试`,
        };
      }
      if (preLookup.found) {
        console.log(`  ⏭ C1 预查重命中: ${platformName}(${accountName}) 已存在最近任务 ${preLookup.found.id || ''}，跳过本次提交`);
        return {
          platform: platformName, account: accountName, accountId,
          success: true,
          skipped: true,
          c1Skipped: true,
          publishMode: yixiaoerConfig.clientId ? '本机发布' : '云发布',
          taskMeta: { taskId: preLookup.found.id || null, raw: preLookup.found },
          titleMeta,
        };
      }

      // 抖音使用全局默认配乐
      let music = null;
      let musicMeta = null;
      if (platformName === '抖音' && config.defaultMusic) {
        musicMeta = await resolveDouyinMusic(accountId, config.defaultMusic);
        music = musicMeta.music;
        console.log(`  🎵 ${musicMeta.message}`);
      } else if (platformName === '抖音') {
        musicMeta = await resolveDouyinMusic(accountId, null);
        music = musicMeta.music;
        console.log(`  🎵 ${musicMeta.message}`);
      }

      onProgress({
        stage: 'submitting',
        title: record.title,
        recordId: record.recordId,
        platform: platformName,
        account: accountName,
        detail: `正在上传素材并提交到${platformName}(${accountName})`,
      });
      if (titleMeta.truncated) {
        console.log(`  ✂️ ${platformName}标题超限，已自动截断为 ${titleMeta.limit} 字`);
      }

      let result;
      try {
        result = await publishContent({
          teamId,
          platforms: [platformName],
          publishType: record.contentType === '视频' ? 'video' : 'imageText',
          platformAccountId: accountId,
          title: titleMeta.text,
          description: record.description || undefined,
          imagePaths: record.imagePaths,
          tags,
          music,
          rules: config.rules || {},
          clientId: yixiaoerConfig.clientId,
          publishChannel: yixiaoerConfig.clientId ? 'local' : 'cloud',
          videoPath: record.videoPath,
          coverPath: record.coverPath,
          videoDuration: record.videoDuration,
          videoSize: record.videoSize,
          ...extraOpts,
        });
      } catch (publishErr) {
        // 链路 C1 防御：发布异常后的二次确认。
        // axios 超时 / ECONNRESET / 网络错误时，蚁小二服务端可能已经接收并执行了请求，
        // 等 5 秒后再查 /taskSets，如果命中，回写为成功（避免下次重发造成重复）。
        const errMsg = String(publishErr?.message || '');
        const looksLikeNetworkErr = /timeout|ETIMEDOUT|ECONNRESET|ECONNABORTED|ECONNREFUSED|socket hang up|network/i.test(errMsg);
        if (looksLikeNetworkErr) {
          console.warn(`  ⚠️ ${platformName}(${accountName}) 网络异常 (${errMsg})，5 秒后做二次确认...`);
          await new Promise(r => setTimeout(r, 5000));
          const echoLookup = await findRecentTaskByTitleAndAccount(
            yixiaoerConfig, platformName, titleMeta.text, accountId, accountName
          );
          if (echoLookup.lookupError) {
            // ============================================================
            // c1Suspect 决策点（2026-04-09 Codex 审计标记 / 已知漏发风险）
            // ============================================================
            // 触发条件：第一次 POST 网络异常（超时/RST/socket hang up），且
            // 5 秒后的二次 /taskSets 查询接口"也挂了"。这是一个双重失败，
            // 此刻客户端无法判断蚁小二服务端到底有没有真的收到+落库这条任务：
            //   A. POST 根本没到 → 服务端没有这条任务
            //   B. POST 到了，蚁小二也成功落库，只是返回包没拿回来
            // 客户端两边都看不见，只能二选一：
            //
            //   选 1）"宁可漏发也不双发"
            //         返回 success:true → scheduler 写"已发布"+落账本
            //         代价：如果实际是 A，这条笔记永远不会被重发，静默漏发
            //         好处：永远不会同一条笔记发两次
            //
            //   选 2）"宁可双发也不漏发"
            //         返回 success:false → scheduler 写"发布失败"，下轮重试
            //         代价：如果实际是 B，下次会再发一次，同一篇笔记发两次
            //         好处：永远不会漏发
            //
            // 当前选 1。理由：
            //   1. 双发被用户骂得比漏发狠（一次双发事故的成本远高于一次漏发）
            //   2. 漏发用户能在小红书后台一眼看出来，自己手动补即可
            //   3. 双发是不可逆的（已经发到平台，删掉对账号权重还有影响）
            //   4. 触发概率极低：要同时满足"POST 网络挂"+"二次 lookup 也挂"
            //
            // 修复方案（已记入 CLAUDE.md 待办，暂不执行，保稳定为主）：
            //   新增飞书状态 `待核验`，c1Suspect 路径只写"待核验"，调度器
            //   单独跑核验循环反复查 /v2/taskSets：命中改"已发布"，多次未
            //   命中改回"待发布"。需要改飞书字段配置 + scheduler 状态机分
            //   支，工作量较大，单独 PR 评估。
            //
            // 修改前请先想清楚两件事：
            //   - 是否确实要从"宁可漏发"切到"宁可双发"
            //   - 双发事故和漏发事故，用户能接受哪种？
            // ============================================================
            console.error(`  🚨 二次确认接口失败 (${echoLookup.lookupError})，为安全起见判定为"疑似已发布"，本条不允许下次重发（已知漏发风险，详见上方注释）`);
            return {
              platform: platformName, account: accountName, accountId,
              success: true,
              c1Suspect: true,
              recoveredFromNetworkError: true,
              publishMode: yixiaoerConfig.clientId ? '本机发布' : '云发布',
              taskMeta: { taskId: null, raw: null },
              musicMeta,
              titleMeta,
              c1SuspectReason: `网络异常 + 二次确认接口失败: ${errMsg}; ${echoLookup.lookupError}`,
            };
          }
          if (echoLookup.found) {
            console.log(`  ✅ 二次确认命中: ${platformName}(${accountName}) 实际已发布 (taskId=${echoLookup.found.id || ''})，回写为成功`);
            return {
              platform: platformName, account: accountName, accountId,
              success: true,
              recoveredFromNetworkError: true,
              publishMode: yixiaoerConfig.clientId ? '本机发布' : '云发布',
              taskMeta: { taskId: echoLookup.found.id || null, raw: echoLookup.found },
              musicMeta,
              titleMeta,
            };
          }
          console.warn(`  ⚠️ 二次确认未命中: ${platformName}(${accountName}) 判定为真失败`);
        }
        throw publishErr;
      }

      // R6 修复：本地 ledger 不再在此处写入，由 scheduler 在 markPlatformStatus 成功后统一写入。
      return { platform: platformName, account: accountName, accountId,
        success: result.success, error: result.success ? null : result.message,
        finalized: result.finalized !== false,
        publishMode: yixiaoerConfig.clientId ? '本机发布' : '云发布',
        taskMeta: result.success ? extractTaskMeta(result.data) : null,
        musicMeta,
        titleMeta,
      };
    } catch (e) {
      return { platform: platformName, account: accountName, accountId,
        success: false, error: e.message };
    }
  }

  // 发布到小红书（跳过已发布的）
  if (record.xiaohongshuAccount && isPendingStatus(record.xiaohongshuStatus)) {
    const resolved = resolveMappedAccountId('小红书', record.xiaohongshuAccount);
    const result = await publishToPlatform('小红书', record.xiaohongshuAccount, resolved.accountId);
    if (result) results.push(result);
  }

  // 发布到抖音（跳过已发布的）
  if (record.douyinAccount && isPendingStatus(record.douyinStatus)) {
    const resolved = resolveMappedAccountId('抖音', record.douyinAccount);
    const result = await publishToPlatform('抖音', record.douyinAccount, resolved.accountId);
    if (result) results.push(result);
  }

  return results;
}

module.exports = {
  ensureLogin,
  getAccountList,
  validateAccount,
  getPublishRecords,
  getTaskSetStatus,
  getAccountAliasIndex,
  collectAccountAliases,
  resetRuntimeState,
  searchMusic: searchMusicGeneral, // 导出通用搜索函数
  searchMusicByAccount: searchMusic, // 保留原函数
  browseMusicByAccount: browseMusic,
  autoSearchMusic,
  getMusicCategories,
  publishContent,
  publishRecord,
  selectTopTags,
  selectTagsForPlatform,
  validateMusicSelection,
  resolveDouyinMusic,
  // 暴露给 scheduler/server 使用，供"飞书状态成功后再写本地账本"的新顺序
  markAsPublished,
  unmarkAsPublished,
  isAlreadyPublished,
  appendHistory,
  getHistoryAccounts,
  computeContentHash,
};

loadPublishedLedger();
loadPublishHistory();
