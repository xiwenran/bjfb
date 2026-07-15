const crypto = require('crypto');

const ACTIVE_XIAOHONGSHU_STATUSES = new Set(['待处理', '待发布', '发布中']);
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

  const getPublishedEntries = recordId => {
    if (!Object.prototype.hasOwnProperty.call(history || {}, recordId)) return [];
    const recordHistory = history[recordId];
    if (!recordHistory || typeof recordHistory !== 'object' || Array.isArray(recordHistory)) {
      throw createError(`发布历史 ${recordId} 无效：记录必须是对象`, 500);
    }
    if (!Object.prototype.hasOwnProperty.call(recordHistory, '小红书')) return [];
    if (!Array.isArray(recordHistory['小红书'])) {
      throw createError(`发布历史 ${recordId}.小红书 无效：必须是数组`, 500);
    }
    for (const [index, entry] of recordHistory['小红书'].entries()) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw createError(`发布历史 ${recordId}.小红书[${index}] 无效：必须是对象`, 500);
      }
    }
    return recordHistory['小红书'];
  };

  const buildReservation = ({ recordId, indexed, accountValue, timeValue, state }) => {
    const account = String(accountValue ?? '').trim();
    if (!account) {
      throw createError(`主题索引记录 ${recordId} 缺少小红书账号，无法检查同主题间隔`, 400);
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
      topicKey: normalizeTopicKey(indexed?.topicKey),
      displayTopic: String(indexed?.displayTopic ?? '').trim(),
      account,
      storeGroup,
      publishTime,
      state,
    };
  };

  const addFact = reservation => {
    const key = [reservation.recordId, reservation.account, reservation.publishTime].join('\u0000');
    const existing = facts.get(key);
    if (!existing || reservation.state === 'published') facts.set(key, reservation);
  };

  for (const [rawRecordId, indexed] of Object.entries(indexedRecords)) {
    const recordId = String(rawRecordId);
    const feishuRecord = feishuById.get(recordId);
    const status = String(feishuRecord?.xiaohongshuStatus ?? feishuRecord?.status ?? '').trim();
    const publishedEntries = getPublishedEntries(recordId);
    const publishedAccounts = new Set();
    for (const entry of publishedEntries) {
      const reservation = buildReservation({
        recordId,
        indexed,
        accountValue: entry?.accountName,
        timeValue: entry?.at,
        state: 'published',
      });
      publishedAccounts.add(reservation.account);
      addFact(reservation);
    }
    if (feishuRecord && ACTIVE_XIAOHONGSHU_STATUSES.has(status)) {
      const scheduledAccount = String(feishuRecord.xiaohongshuAccount ?? '').trim();
      if (!publishedAccounts.has(scheduledAccount)) {
        addFact(buildReservation({
          recordId,
          indexed,
          accountValue: scheduledAccount,
          timeValue: feishuRecord.publishTime,
          state: 'scheduled',
        }));
      }
    }
  }

  return [...facts.values()];
}

function makeConflictId(topicKey, storeGroup, accounts) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([topicKey, storeGroup, accounts]))
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
      if (!topicKey) throw createError(`${sourceLabel}[${index}] 缺少具体主题，无法检查同主题间隔`, 400);
      if (!storeGroup) throw createError(`${sourceLabel}[${index}] 缺少店铺组，无法检查同主题间隔`, 400);
      if (!account) throw createError(`${sourceLabel}[${index}] 缺少账号，无法检查同主题间隔`, 400);
      const key = `${storeGroup}\u0000${topicKey}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push({ ...rawItem, topicKey, storeGroup, account, source });
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
    conflicts.push({
      id: makeConflictId(first.topicKey, first.storeGroup, accounts),
      topicKey: first.topicKey,
      displayTopic: String(sortedItems.find(item => item.displayTopic)?.displayTopic ?? first.topicKey),
      storeGroup: first.storeGroup,
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
