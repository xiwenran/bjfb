const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { publishToXiaohongshuViaBitBrowser } = require('./bitbrowser-xhs.js');
const { loadConfig, readLedger, saveLedger } = require('./config-store.js');
const DEFAULT_API_BASE_URL = 'https://www.yixiaoer.cn/api';
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

function resetRuntimeState() {
  loginDone = false;
  authSignature = null;
  activeYixiaoerConfig = null;
  cachedHttpClient = null;
  cachedHttpClientSignature = null;
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
    timeout: 30000,
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
    throw new Error(`蚁小二API错误: ${message}`);
  }
}

async function getTeams(config) {
  const result = await requestApi(config, 'GET', '/teams');
  return result?.data || result || [];
}

async function getAccounts(config, params = {}) {
  const result = await requestApi(config, 'GET', '/platform-accounts', {
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
  const result = await requestApi(config, 'GET', '/taskSets', {
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

async function getAccountTopicsApi(config, platformAccountId, keyword) {
  return requestApi(config, 'GET', `/platform-accounts/${platformAccountId}/topics`, {
    keyWord: keyword,
  });
}

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
  const form = {
    formType: 'task',
    covers: [],
  };

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
  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;

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
  const accounts = await getAccountList({ loginStatus: 1 });
  return accounts.some(a => a.id === platformAccountId);
}

async function getPublishRecords(options = {}) {
  const yixiaoerConfig = getActiveYixiaoerConfig();
  const result = await getPublishRecordsApi(yixiaoerConfig, {
    page: options.page || 1,
    size: options.size || 50,
  });
  return result.data || [];
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
    const imageObjects = [];
    for (const imagePath of params.imagePaths) {
      if (imagePath.startsWith('http')) {
        imageObjects.push({
          path: imagePath,
          width: params.coverWidth || 1080,
          height: params.coverHeight || 1920,
          size: params.coverSize || 0,
        });
      } else {
        const imageInfo = await uploadFileToOss(yixiaoerConfig, imagePath);
        imageObjects.push({
          key: imageInfo.key,
          width: params.coverWidth || 1080,
          height: params.coverHeight || 1920,
          size: imageInfo.size,
        });
      }
    }
    accountForm.images = imageObjects;
    if (!accountForm.coverKey && imageObjects.length > 0) {
      const first = imageObjects[0];
      if (first.key) accountForm.coverKey = first.key;
      accountForm.cover = {
        key: first.key,
        path: first.path,
        width: first.width,
        height: first.height,
        size: first.size,
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

  const data = await publishTaskApi(yixiaoerConfig, payload);
  return {
    success: true,
    message: `✅ ${(finalPublishChannel === 'local' ? '本机发布' : '云发布')}任务已提交到 ${platformNames.join(', ')}`,
    data,
  };
}

// 已发布记录缓存（防止同一内容重复发到同一平台）
const publishedCache = new Map(); // key: "recordId:platform" → true

function loadPublishedLedger() {
  try {
    const data = readLedger();
    for (const key of Object.keys(data || {})) {
      if (data[key]) publishedCache.set(key, true);
    }
  } catch (e) {
    console.warn(`⚠️ 读取发布账本失败: ${e.message}`);
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

function getPublishKey(recordId, platform) {
  return `${recordId}:${platform}`;
}

function isAlreadyPublished(recordId, platform) {
  return publishedCache.has(getPublishKey(recordId, platform));
}

function markAsPublished(recordId, platform) {
  publishedCache.set(getPublishKey(recordId, platform), true);
  savePublishedLedger();
}

function unmarkAsPublished(recordId, platform) {
  const key = getPublishKey(recordId, platform);
  if (!publishedCache.has(key)) return;
  publishedCache.delete(key);
  savePublishedLedger();
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

  // 飞书平台状态是是否允许重发的唯一开关。
  // 若用户手动把平台状态改回“待发布”，则清除本地防重账本，允许重新提交到蚁小二。
  if (record.xiaohongshuStatus === '已发布') {
    markAsPublished(record.recordId, '小红书');
  } else if (isPendingStatus(record.xiaohongshuStatus)) {
    unmarkAsPublished(record.recordId, '小红书');
  }

  if (record.douyinStatus === '已发布') {
    markAsPublished(record.recordId, '抖音');
  } else if (isPendingStatus(record.douyinStatus)) {
    unmarkAsPublished(record.recordId, '抖音');
  }

  // 发布到单个平台的通用函数
  async function publishToPlatform(platformName, accountName, accountId, extraOpts) {
    const xhsPublishChannel = record.xiaohongshuPublishChannel === '比特浏览器' ? '比特浏览器' : '蚁小二';
    const platformStatus = platformName === '小红书' ? record.xiaohongshuStatus : record.douyinStatus;

    if (!isPendingStatus(platformStatus)) {
      return null;
    }

    // 防重复：检查是否已在该平台发布过
    if (isAlreadyPublished(record.recordId, platformName)) {
      console.log(`  ⏭ 跳过${platformName}: "${record.title}" 已在该平台发布过`);
      return { platform: platformName, account: accountName, accountId, success: true, skipped: true };
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

        if (result.success) {
          markAsPublished(record.recordId, platformName);
        }

        return {
          platform: platformName,
          account: accountName,
          accountId: browserId,
          success: result.success,
          error: result.success ? null : result.message,
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

      const result = await publishContent({
        teamId,
        platforms: [platformName],
        publishType: record.contentType === '视频' ? 'video' : 'imageText',
        platformAccountId: accountId,
        title: titleMeta.text,
        description: record.description || undefined,
        imagePaths: record.imagePaths,
        tags,
        music,
        clientId: yixiaoerConfig.clientId,
        publishChannel: yixiaoerConfig.clientId ? 'local' : 'cloud',
        videoPath: record.videoPath,
        coverPath: record.coverPath,
        videoDuration: record.videoDuration,
        videoSize: record.videoSize,
        ...extraOpts,
      });

      if (result.success) {
        markAsPublished(record.recordId, platformName);
      }

      return { platform: platformName, account: accountName, accountId,
        success: result.success, error: result.success ? null : result.message,
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
};

loadPublishedLedger();
