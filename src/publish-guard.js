const MIN_SAME_ACCOUNT_INTERVAL_MINUTES = 360;
const MIN_SAME_ACCOUNT_INTERVAL_MS = MIN_SAME_ACCOUNT_INTERVAL_MINUTES * 60 * 1000;

const PLATFORM_ALIASES = new Map([
  ['xiaohongshu', 'xiaohongshu'],
  ['xiaohongshuaccount', 'xiaohongshu'],
  ['小红书', 'xiaohongshu'],
  ['douyin', 'douyin'],
  ['douyinaccount', 'douyin'],
  ['抖音', 'douyin'],
]);

function toIsoString(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizePublishedEntry(value, now = Date.now()) {
  if (!value) return null;

  if (value === true) {
    return {
      submittedAt: toIsoString(now),
      observedPublishedAt: null,
    };
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const submittedAt = toIsoString(
    value.submittedAt
    || value.lastSubmittedAt
    || value.createdAt
    || now
  );

  return {
    submittedAt,
    observedPublishedAt: toIsoString(
      value.observedPublishedAt
      || value.publishedAt
      || value.lastPublishedAt
      || null
    ),
  };
}

function createSubmittedEntry(now = Date.now()) {
  return {
    submittedAt: toIsoString(now),
    observedPublishedAt: null,
  };
}

function markEntryObservedPublished(entry, now = Date.now()) {
  const normalized = normalizePublishedEntry(entry, now) || createSubmittedEntry(now);
  return {
    ...normalized,
    observedPublishedAt: toIsoString(now),
  };
}

function shouldKeepEntryForPendingStatus(entry, now = Date.now(), guardMs = 2 * 60 * 1000) {
  const normalized = normalizePublishedEntry(entry, now);
  if (!normalized) return false;
  if (normalized.observedPublishedAt) return false;

  const submittedAt = Date.parse(normalized.submittedAt || '');
  if (!Number.isFinite(submittedAt)) return false;

  return now - submittedAt < guardMs;
}

function normalizePlatformKey(platform) {
  const key = String(platform || '').trim().toLowerCase();
  return PLATFORM_ALIASES.get(key) || key;
}

function getPlatformLabel(platform) {
  const key = normalizePlatformKey(platform);
  if (key === 'xiaohongshu') return '小红书';
  if (key === 'douyin') return '抖音';
  return String(platform || '').trim();
}

function parsePublishTimestamp(value) {
  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isFinite(ts) ? ts : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value || '').trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?$/.test(text)
    ? text.replace(' ', 'T')
    : text;
  const ts = new Date(normalized).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function getRecordPlatformAccounts(record, options = {}) {
  const pendingOnly = options.pendingOnly === true;
  const isPending = typeof options.isPending === 'function' ? options.isPending : status => status === '待发布';
  const accounts = [];
  const xhsAccount = String(record?.xiaohongshuAccount || '').trim();
  if (xhsAccount && (!pendingOnly || isPending(record?.xiaohongshuStatus))) {
    accounts.push({ platform: 'xiaohongshu', platformLabel: '小红书', account: xhsAccount });
  }
  const douyinAccount = String(record?.douyinAccount || '').trim();
  if (douyinAccount && (!pendingOnly || isPending(record?.douyinStatus))) {
    accounts.push({ platform: 'douyin', platformLabel: '抖音', account: douyinAccount });
  }
  return accounts;
}

function buildSameAccountKey(platform, account) {
  return `${normalizePlatformKey(platform)}:${String(account || '').trim()}`;
}

function findSameAccountIntervalViolations(entries, options = {}) {
  const minIntervalMs = Math.max(
    MIN_SAME_ACCOUNT_INTERVAL_MS,
    Number(options.minIntervalMs) || 0
  );
  const getTime = options.getTime || (entry => entry.publishTime);
  const getPlatformAccounts = options.getPlatformAccounts || (entry => [{
    platform: entry.platform,
    platformLabel: getPlatformLabel(entry.platform),
    account: entry.account,
  }]);
  const getLabel = options.getLabel || (entry => entry.noteKey || entry.recordId || entry.title || 'unknown');

  const groups = new Map();
  const violations = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const rawTime = getTime(entry);
    const platformAccounts = getPlatformAccounts(entry).filter(item => item?.account);
    if (rawTime === null || rawTime === undefined || String(rawTime).trim() === '') {
      continue;
    }
    const ts = parsePublishTimestamp(rawTime);
    if (ts === null && platformAccounts.length > 0) {
      for (const item of platformAccounts) {
        violations.push({
          type: 'invalid_time',
          platform: normalizePlatformKey(item.platform),
          platformLabel: item.platformLabel || getPlatformLabel(item.platform),
          account: item.account,
          label: getLabel(entry),
        });
      }
      continue;
    }
    for (const item of platformAccounts) {
      const key = buildSameAccountKey(item.platform, item.account);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        ts,
        label: getLabel(entry),
        platform: normalizePlatformKey(item.platform),
        platformLabel: item.platformLabel || getPlatformLabel(item.platform),
        account: item.account,
      });
    }
  }

  for (const items of groups.values()) {
    items.sort((a, b) => a.ts - b.ts);
    for (const [prev, next] of items.slice(1).map((item, index) => [items[index], item])) {
      const gapMs = next.ts - prev.ts;
      if (gapMs < minIntervalMs) {
        violations.push({
          type: 'too_close',
          platform: next.platform,
          platformLabel: next.platformLabel,
          account: next.account,
          previousLabel: prev.label,
          nextLabel: next.label,
          previousTime: prev.ts,
          nextTime: next.ts,
          gapMs,
          minIntervalMs,
        });
      }
    }
  }
  return violations;
}

function canUseSameAccountSlot(lastTimestamp, nextTimestamp, minIntervalMs = MIN_SAME_ACCOUNT_INTERVAL_MS) {
  if (lastTimestamp === null || lastTimestamp === undefined) return true;
  if (!Number.isFinite(lastTimestamp) || !Number.isFinite(nextTimestamp)) return false;
  return nextTimestamp - lastTimestamp >= Math.max(0, Number(minIntervalMs) || 0);
}

module.exports = {
  normalizePublishedEntry,
  createSubmittedEntry,
  markEntryObservedPublished,
  shouldKeepEntryForPendingStatus,
  MIN_SAME_ACCOUNT_INTERVAL_MINUTES,
  MIN_SAME_ACCOUNT_INTERVAL_MS,
  normalizePlatformKey,
  getPlatformLabel,
  parsePublishTimestamp,
  getRecordPlatformAccounts,
  buildSameAccountKey,
  findSameAccountIntervalViolations,
  canUseSameAccountSlot,
};
