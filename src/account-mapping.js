function normalizeAccountAlias(value) {
  return String(value || '').trim();
}

function dedupeAliases(values = []) {
  const aliases = [];
  const seen = new Set();

  for (const value of values) {
    const alias = normalizeAccountAlias(value);
    if (!alias) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }

  return aliases;
}

function resolvePlatformKey(input) {
  const platform = normalizeAccountAlias(input);
  if (!platform) return null;
  if (platform === 'xiaohongshu' || platform === '小红书') return 'xiaohongshu';
  if (platform === 'douyin' || platform === '抖音') return 'douyin';
  return null;
}

function resolvePlatformKeyFromAccount(account = {}) {
  return resolvePlatformKey(account.platformName);
}

function sameAliases(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

function updateYixiaoerAccountCache(config, accounts = [], collectAccountAliases = () => []) {
  config.yixiaoerAccountCache = config.yixiaoerAccountCache || { xiaohongshu: {}, douyin: {} };
  let changed = false;

  for (const account of accounts) {
    const platformKey = resolvePlatformKeyFromAccount(account);
    if (!platformKey || !account.id) continue;

    const aliases = dedupeAliases(collectAccountAliases(account));
    const previous = config.yixiaoerAccountCache[platformKey][account.id];
    const nextEntry = {
      aliases,
      platformName: account.platformName,
      accountName: account.platformAccountName || aliases[0] || '',
      syncedAt: previous?.syncedAt || new Date().toISOString(),
    };

    const hasChanged = !previous
      || previous.platformName !== nextEntry.platformName
      || previous.accountName !== nextEntry.accountName
      || !sameAliases(previous.aliases || [], nextEntry.aliases);

    if (!hasChanged) continue;

    nextEntry.syncedAt = new Date().toISOString();
    config.yixiaoerAccountCache[platformKey][account.id] = nextEntry;
    changed = true;
  }

  return { changed, cache: config.yixiaoerAccountCache };
}

function buildDesiredAccountNamesFromRecords(records = []) {
  const collected = {
    xiaohongshu: [],
    douyin: [],
  };
  const seen = {
    xiaohongshu: new Set(),
    douyin: new Set(),
  };

  for (const record of records) {
    const xhs = normalizeAccountAlias(record?.xiaohongshuAccount);
    if (xhs) {
      const key = xhs.toLowerCase();
      if (!seen.xiaohongshu.has(key)) {
        seen.xiaohongshu.add(key);
        collected.xiaohongshu.push(xhs);
      }
    }

    const dy = normalizeAccountAlias(record?.douyinAccount);
    if (dy) {
      const key = dy.toLowerCase();
      if (!seen.douyin.has(key)) {
        seen.douyin.add(key);
        collected.douyin.push(dy);
      }
    }
  }

  return collected;
}

function buildAliasIndex(accounts = [], collectAccountAliases = () => []) {
  const index = {
    xiaohongshu: new Map(),
    douyin: new Map(),
  };

  for (const account of accounts) {
    const platformKey = resolvePlatformKeyFromAccount(account);
    if (!platformKey || !account.id) continue;

    const aliases = dedupeAliases([
      account.platformAccountName,
      ...collectAccountAliases(account),
    ]);

    for (const alias of aliases) {
      const key = alias.toLowerCase();
      if (!index[platformKey].has(key)) {
        index[platformKey].set(key, []);
      }

      index[platformKey].get(key).push({
        id: account.id,
        accountName: account.platformAccountName || aliases[0] || '',
        aliases,
      });
    }
  }

  return index;
}

function collectMappedAccountIds(config = {}) {
  return new Set([
    ...Object.values(config.accountMapping?.xiaohongshu || {}),
    ...Object.values(config.accountMapping?.douyin || {}),
  ].filter(Boolean));
}

function autoMapAccountMappings(config, desiredNamesByPlatform = {}, accounts = [], collectAccountAliases = () => []) {
  config.accountMapping = config.accountMapping || { xiaohongshu: {}, douyin: {} };
  config.accountMapping.xiaohongshu = config.accountMapping.xiaohongshu || {};
  config.accountMapping.douyin = config.accountMapping.douyin || {};

  const aliasIndex = buildAliasIndex(accounts, collectAccountAliases);
  const added = [];
  let changed = false;

  for (const platformKey of ['xiaohongshu', 'douyin']) {
    const mapping = config.accountMapping[platformKey];
    const desiredNames = dedupeAliases(desiredNamesByPlatform[platformKey] || []);

    for (const accountName of desiredNames) {
      if (mapping[accountName]) continue;

      const candidates = aliasIndex[platformKey].get(accountName.toLowerCase()) || [];
      const uniqueCandidates = Array.from(new Map(
        candidates.map(candidate => [candidate.id, candidate])
      ).values());

      if (uniqueCandidates.length !== 1) continue;

      const match = uniqueCandidates[0];
      mapping[accountName] = match.id;
      added.push({
        platformKey,
        accountName,
        accountId: match.id,
        matchedAlias: accountName,
      });
      changed = true;
    }
  }

  return {
    changed,
    added,
    mappedIds: collectMappedAccountIds(config),
  };
}

module.exports = {
  normalizeAccountAlias,
  updateYixiaoerAccountCache,
  buildDesiredAccountNamesFromRecords,
  autoMapAccountMappings,
  collectMappedAccountIds,
  resolvePlatformKey,
  resolvePlatformKeyFromAccount,
};
