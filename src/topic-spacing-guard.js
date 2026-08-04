const crypto = require('crypto');

const ACTIVE_PLATFORM_STATUSES = new Set(['待处理', '待发布', '发布中']);
const ACCEPTED_CONFIRMATION_DECISIONS = new Set(['auto_space', 'allow_conflicts']);
const MIN_RESERVATION_TIME = Date.UTC(2000, 0, 1);
const MAX_RESERVATION_TIME = Date.UTC(2100, 0, 1);

function createError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeTopicKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, stableValue(value[key])])
    );
  }
  return value;
}

function buildTopicCheckFingerprint(input) {
  const relevantInput = {
    noteFolders: input?.noteFolders ?? [],
    accounts: input?.accounts ?? {},
    accountGroups: input?.accountGroups ?? {},
    timeSlots: input?.timeSlots ?? {},
    timeWindows: input?.timeWindows ?? {},
    perAccountPerSlot: input?.perAccountPerSlot ?? 1,
    seed: String(input?.seed ?? ''),
  };
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(relevantInput)))
    .digest('hex');
}

function parseReservationTime(value) {
  let timestamp = null;
  if (value instanceof Date) {
    timestamp = value.getTime();
  } else if (typeof value === 'number') {
    timestamp = Number.isInteger(value) ? value : null;
  } else {
    const text = String(value ?? '').trim();
    if (!text) return null;
    if (/^\d+$/.test(text)) {
      const numeric = Number(text);
      timestamp = Number.isInteger(numeric) ? numeric : null;
    } else {
      const parsed = new Date(text).getTime();
      timestamp = Number.isFinite(parsed) ? parsed : null;
    }
  }
  return Number.isInteger(timestamp)
    && timestamp >= MIN_RESERVATION_TIME
    && timestamp < MAX_RESERVATION_TIME
    ? timestamp
    : null;
}

// 双平台定义：历史记录键、飞书字段名各自不同。原实现写死小红书（'小红书' history key、
// xiaohongshuAccount/xiaohongshuStatus 字段），现在两个平台都要收集，抽成表驱动。
const PLATFORM_RESERVATION_DEFS = [
  { platform: 'xiaohongshu', historyKey: '小红书', accountField: 'xiaohongshuAccount', statusField: 'xiaohongshuStatus' },
  { platform: 'douyin', historyKey: '抖音', accountField: 'douyinAccount', statusField: 'douyinStatus' },
];

function collectIndexedReservations({ topicIndex, feishuRecords, history, accountGroups }) {
  const indexedRecords = topicIndex?.records && typeof topicIndex.records === 'object'
    ? topicIndex.records
    : {};
  const feishuById = new Map(
    (Array.isArray(feishuRecords) ? feishuRecords : [])
      .map(record => [String(record?.recordId ?? ''), record])
      .filter(([recordId]) => recordId)
  );
  const normalizedGroups = new Map(
    Object.entries(accountGroups && typeof accountGroups === 'object' ? accountGroups : {})
      .map(([account, storeGroup]) => [String(account).trim(), String(storeGroup ?? '').trim()])
      .filter(([account]) => account)
  );
  const facts = new Map();

  const getPublishedEntries = (recordId, historyKey) => {
    if (!Object.prototype.hasOwnProperty.call(history || {}, recordId)) return [];
    const recordHistory = history[recordId];
    if (!recordHistory || typeof recordHistory !== 'object' || Array.isArray(recordHistory)) {
      throw createError(`发布历史 ${recordId} 无效：记录必须是对象`, 500);
    }
    if (!Object.prototype.hasOwnProperty.call(recordHistory, historyKey)) return [];
    if (!Array.isArray(recordHistory[historyKey])) {
      throw createError(`发布历史 ${recordId}.${historyKey} 无效：必须是数组`, 500);
    }
    for (const [index, entry] of recordHistory[historyKey].entries()) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw createError(`发布历史 ${recordId}.${historyKey}[${index}] 无效：必须是对象`, 500);
      }
    }
    return recordHistory[historyKey];
  };

  const buildReservation = ({ recordId, indexed, platform, accountValue, timeValue, state }) => {
    const account = String(accountValue ?? '').trim();
    if (!account) {
      throw createError(`主题索引记录 ${recordId}（${platform}）缺少账号，无法检查同主题间隔`, 400);
    }
    const storeGroup = normalizedGroups.get(account);
    if (!storeGroup) {
      throw createError(`账号“${account}”未配置店铺组，无法检查同主题间隔`, 400);
    }
    const publishTime = parseReservationTime(timeValue);
    if (publishTime === null) {
      throw createError(`主题索引记录 ${recordId} 的发布时间无效，无法检查同主题间隔`, 400);
    }
    return {
      recordId,
      platform,
      topicKey: normalizeTopicKey(indexed?.topicKey),
      displayTopic: String(indexed?.displayTopic ?? '').trim(),
      account,
      storeGroup,
      publishTime,
      state,
    };
  };

  const addFact = reservation => {
    // 去重键加上 platform：同一 recordId 理论上只属于一张表，但双表模式下同一账号名
    // 可能在小红书、抖音两侧各出现一次，不能只按 recordId+account+publishTime 去重。
    const key = [reservation.platform, reservation.recordId, reservation.account, reservation.publishTime].join('\u0000');
    const existing = facts.get(key);
    if (!existing || reservation.state === 'published') facts.set(key, reservation);
  };

  for (const [rawRecordId, indexed] of Object.entries(indexedRecords)) {
    const recordId = String(rawRecordId);
    const feishuRecord = feishuById.get(recordId);
    for (const { platform, historyKey, accountField, statusField } of PLATFORM_RESERVATION_DEFS) {
      const status = String(feishuRecord?.[statusField] ?? '').trim();
      const publishedEntries = getPublishedEntries(recordId, historyKey);
      const publishedAccounts = new Set();
      for (const entry of publishedEntries) {
        const reservation = buildReservation({
          recordId,
          indexed,
          platform,
          accountValue: entry?.accountName,
          timeValue: entry?.at,
          state: 'published',
        });
        publishedAccounts.add(reservation.account);
        addFact(reservation);
      }
      // 只有该平台的发布状态字段命中活跃状态时才需要这条"计划中"预约——纯小红书记录
      // 在抖音这一路的 douyinStatus 天然是空字符串，不在 ACTIVE_PLATFORM_STATUSES 里，
      // 这个 if 本身就会跳过，不会走到下面。一旦状态确实活跃却没有账号，说明数据本身
      // 有问题（状态和账号字段不一致），继续 fail-closed 交给 buildReservation 抛错，
      // 不能静默跳过——这是原实现的既有行为，双平台化不应该削弱它。
      if (feishuRecord && ACTIVE_PLATFORM_STATUSES.has(status)) {
        const scheduledAccount = String(feishuRecord[accountField] ?? '').trim();
        if (!publishedAccounts.has(scheduledAccount)) {
          addFact(buildReservation({
            recordId,
            indexed,
            platform,
            accountValue: scheduledAccount,
            timeValue: feishuRecord.publishTime,
            state: 'scheduled',
          }));
        }
      }
    }
  }

  return [...facts.values()];
}

function makeConflictId(platform, topicKey, storeGroups, accounts) {
  // storeGroups 现在是一个数组（分组键不再含单一 storeGroup），指纹要把它纳入，
  // 否则同平台同主题但店铺组构成不同的两批冲突会撞出同一个 id。
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([platform, topicKey, storeGroups, accounts]))
    .digest('hex')
    .slice(0, 16);
}

function compareConflictItem(left, right) {
  const leftKey = [left.account, left.noteKey ?? '', left.recordId ?? '', left.publishTime ?? ''].join('\u0000');
  const rightKey = [right.account, right.noteKey ?? '', right.recordId ?? '', right.publishTime ?? ''].join('\u0000');
  return leftKey.localeCompare(rightKey);
}

function findCrossAccountTopicConflicts({ currentItems, reservations }) {
  const grouped = new Map();
  const addItems = (items, source) => {
    const sourceLabel = source === 'current' ? '本批主题项' : '历史主题预约';
    for (const [index, rawItem] of (Array.isArray(items) ? items : []).entries()) {
      const topicKey = normalizeTopicKey(rawItem?.topicKey || rawItem?.displayTopic);
      const storeGroup = String(rawItem?.storeGroup ?? '').trim();
      const account = String(rawItem?.account ?? '').trim();
      // platform 缺省按小红书处理：向后兼容老调用方（本文件内 server.js 的
      // buildPotentialConflictItems 已经会传 platform，这里兜底防止漏传时报错）。
      const platform = String(rawItem?.platform ?? '').trim() || 'xiaohongshu';
      if (!topicKey) throw createError(`${sourceLabel}[${index}] 缺少具体主题，无法检查同主题间隔`, 400);
      if (!storeGroup) throw createError(`${sourceLabel}[${index}] 缺少店铺组，无法检查同主题间隔`, 400);
      if (!account) throw createError(`${sourceLabel}[${index}] 缺少账号，无法检查同主题间隔`, 400);
      // 分组键改为「平台 + 主题」，不再含店铺组：跨店铺同主题也要能分到同一组，
      // 才谈得上区分「同店铺（需审批）」与「跨店铺（硬约束）」两种冲突类型。
      const key = `${platform}\u0000${topicKey}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push({ ...rawItem, topicKey, storeGroup, account, platform, source });
    }
  };
  addItems(currentItems, 'current');
  addItems(reservations, 'reservation');

  const conflicts = [];
  for (const items of grouped.values()) {
    if (!items.some(item => item.source === 'current')) continue;
    const accounts = [...new Set(items.map(item => item.account))].sort();
    if (accounts.length < 2) continue;
    const sortedItems = items.slice().sort(compareConflictItem);
    const first = sortedItems[0];
    const storeGroups = [...new Set(items.map(item => item.storeGroup))].sort();
    // 组内出现 ≥2 个不同店铺组，说明这批冲突里至少有一对账号是跨店铺的——
    // 跨店铺同主题是硬约束（规则 A），不能靠人工审批放行；只有全部账号同店铺
    // 才是纯规则 B（同店铺同主题需审批）。
    const isCrossStore = storeGroups.length > 1;
    conflicts.push({
      id: makeConflictId(first.platform, first.topicKey, storeGroups, accounts),
      platform: first.platform,
      topicKey: first.topicKey,
      displayTopic: String(sortedItems.find(item => item.displayTopic)?.displayTopic ?? first.topicKey),
      // storeGroup 保留旧字段供向后兼容：storeGroups.length===1 时就是那唯一的店铺组，
      // 跨店铺时只是排序后的第一个，仅供展示参考，不作为判断依据——判断请用 scope。
      storeGroup: first.storeGroup,
      storeGroups,
      scope: isCrossStore ? 'cross_store' : 'same_store',
      scopeLabel: isCrossStore ? '跨店铺（硬约束）' : '同店铺（需审批）',
      accounts,
      items: sortedItems,
    });
  }
  return conflicts.sort((left, right) => left.id.localeCompare(right.id));
}

function validateTopicConfirmation({ fingerprint, conflicts, confirmation }) {
  const expectedConflicts = Array.isArray(conflicts) ? conflicts : [];
  if (expectedConflicts.length === 0) return true;

  if (!confirmation || String(confirmation.inputFingerprint ?? '') !== String(fingerprint ?? '')) {
    throw createError('排期前同主题确认已失效，请重新检查', 409);
  }
  if (confirmation.decision === 'adjust_window') {
    throw createError('已选择调整时间窗，请修改输入后重新检查同主题冲突', 409);
  }
  if (!ACCEPTED_CONFIRMATION_DECISIONS.has(confirmation.decision)) {
    throw createError('同主题确认决定无效，仅支持 auto_space 或 allow_conflicts', 409);
  }

  const approvedIds = new Set(Array.isArray(confirmation.conflictIds) ? confirmation.conflictIds : []);
  const missingIds = expectedConflicts.map(conflict => conflict.id).filter(id => !approvedIds.has(id));
  if (missingIds.length > 0) {
    throw createError(`仍有未确认的同主题冲突：${missingIds.join('、')}`, 409);
  }
  const expectedIds = new Set(expectedConflicts.map(conflict => conflict.id));
  const extraIds = [...approvedIds].filter(id => !expectedIds.has(id));
  if (extraIds.length > 0) {
    throw createError(`确认中包含不属于当前检查的冲突：${extraIds.join('、')}`, 409);
  }
  return true;
}

module.exports = {
  normalizeTopicKey,
  buildTopicCheckFingerprint,
  collectIndexedReservations,
  findCrossAccountTopicConflicts,
  validateTopicConfirmation,
};
