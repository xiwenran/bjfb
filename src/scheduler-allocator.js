// 求解已迁出软件（Python 本地脚本），本文件只做「接收 schedule + 全量校验」。
// 校验一条不过即整批拒收；违规必须一次性全部收集后再抛出，方便调用方一次看到全部问题。
const fs = require('fs');
const path = require('path');
const { parsePublishTimestamp } = require('./publish-guard.js');

const CONSTRAINTS_PATH = path.join(__dirname, 'schedule-constraints.json');
const SUPPORTED_PLATFORMS = new Set(['xiaohongshu', 'douyin']);
const EXACT_MINUTE_PATTERN = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/;

// 账号名归一化：与发布链路 account-mapping.js 的 toLowerCase 匹配口径统一，
// 避免 "acc" / "Acc" 在校验器里被当成两个账号绕过同账号间隔约束。
// 归一化结果只用于分组比较，报错信息一律展示用户原始账号名。
function normalizeAccountName(value) {
  return String(value ?? '').trim().toLowerCase();
}

// 店铺组 / 主题分组键归一化：与 topic-spacing-guard.js 的 normalizeTopicKey 同源
// （NFKC + 空白折叠 + trim），再补一层 toLowerCase，避免大小写差异绕过跨账号主题间隔。
function normalizeGroupKey(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function createInputError(message, violations) {
  const error = new Error(message);
  error.statusCode = 400;
  if (violations) error.violations = violations;
  return error;
}

// 正数校验的公共小工具：四个新字段都要求"能转成数字 + 大于 0"，抽出来避免四处重复同一段判断。
function readPositiveNumber(parsed, field) {
  const value = Number(parsed[field]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`schedule-constraints.json 中 ${field} 无效: ${parsed[field]}`);
  }
  return value;
}

let _constraintsCache = null;
function loadConstraints() {
  if (_constraintsCache) return _constraintsCache;
  const raw = fs.readFileSync(CONSTRAINTS_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const minutes = readPositiveNumber(parsed, 'minSameAccountIntervalMinutes');
  // 跨店铺同主题跨账号间隔（规则 A）：硬约束，无条件执行，不受 topicDecision 影响。
  const crossStoreTopicIntervalMinutes = readPositiveNumber(parsed, 'minCrossStoreTopicIntervalMinutes');
  // 主题发布量：7 天窗口超过 topicVolumeMaxCount 条只告警（规则 C），30 天窗口只统计（规则 D）。
  const topicVolumeWindowDays = readPositiveNumber(parsed, 'topicVolumeWindowDays');
  const topicVolumeMaxCount = readPositiveNumber(parsed, 'topicVolumeMaxCount');
  const topicVolumeLongWindowDays = readPositiveNumber(parsed, 'topicVolumeLongWindowDays');
  // uniqueMinuteAcrossBatch 字段在配置文件里保留，但不再读取成开关：
  // 分钟全局唯一是硬约束，不接受被配置关掉。
  _constraintsCache = {
    minSameAccountIntervalMinutes: minutes,
    minCrossStoreTopicIntervalMinutes: crossStoreTopicIntervalMinutes,
    topicVolumeWindowDays,
    topicVolumeMaxCount,
    topicVolumeLongWindowDays,
  };
  return _constraintsCache;
}

function normalizeCoverageStrategy(value) {
  const raw = String(value || '').trim() || 'minimum';
  const aliases = new Map([
    ['strict', 'strict'], ['严格覆盖', 'strict'],
    ['balanced', 'balanced'], ['尽量覆盖', 'balanced'],
    ['minimum', 'minimum'], ['只保底发布', 'minimum'],
  ]);
  const normalized = aliases.get(raw);
  if (!normalized) {
    throw createInputError('coverageStrategy 仅支持 strict/严格覆盖、balanced/尽量覆盖、minimum/只保底发布');
  }
  return normalized;
}

function parseStrictTimestamp(value) {
  const text = String(value || '').trim();
  const dateMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (dateMatch) {
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const calendarDate = new Date(year, month - 1, day);
    if (calendarDate.getFullYear() !== year || calendarDate.getMonth() !== month - 1 || calendarDate.getDate() !== day) {
      return null;
    }
    if (dateMatch[4] !== undefined) {
      const hour = Number(dateMatch[4]);
      const minute = Number(dateMatch[5]);
      if (hour > 23 || minute > 59) return null;
    }
  }
  return parsePublishTimestamp(value);
}

function formatMinute(timestamp) {
  const date = new Date(timestamp);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// existingReservations 是两路合并的：
//   - scope='topic'（默认）：来自主题索引的小红书排期，带 topicKey/storeGroup，
//     同时供约束 1（同账号间隔）、约束 2（分钟唯一）、约束 5（同店同主题跨账号间隔）。
//   - scope='time'：平台无关的「已占用分钟」，小红书和抖音都有，不带主题/店铺组，
//     只供约束 1、2。它不能进约束 5——那条约束在 auto_space 下对缺主题/店铺组的条目
//     是 fail-closed 记违规的，放进去会把没有主题信息的抖音排期误判成违规。
// 默认 'topic' 是为了保持旧调用方（只传 topicKey/storeGroup 的一路）行为不变。
const RESERVATION_SCOPES = new Set(['topic', 'time']);

function normalizeExistingReservations(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw createInputError('existingReservations 必须是数组');
  const normalized = value.map(item => {
    const platform = String(item?.platform || '').trim();
    const account = String(item?.account || '').trim();
    const timestamp = parseStrictTimestamp(item?.publishTime);
    if (!SUPPORTED_PLATFORMS.has(platform) || !account || timestamp === null) {
      throw createInputError('已有排期记录缺少合法 platform、account 或 publishTime');
    }
    const scope = String(item?.scope || 'topic').trim() || 'topic';
    if (!RESERVATION_SCOPES.has(scope)) {
      throw createInputError(`已有排期记录的 scope 只能是 topic 或 time，实际为 "${item?.scope}"`);
    }
    // existingReservations 由服务端 loadTopicSpacingContext 生成（topicKey / storeGroup 都是
    // 服务端权威值），这里只做归一化，不做来源替换。
    const topicKey = String(item?.topicKey || '').trim();
    const storeGroup = String(item?.storeGroup || '').trim();
    return {
      platform,
      account,
      scope,
      accountKey: `${platform}:${normalizeAccountName(account)}`,
      accountLabel: `${platform}:${account}`,
      timestamp,
      minute: formatMinute(timestamp),
      topicKey,
      topicGroupKey: normalizeGroupKey(topicKey),
      storeGroup,
      storeGroupKey: normalizeGroupKey(storeGroup),
      label: `既有排期:${platform}:${account}@${formatMinute(timestamp)}`,
    };
  });

  // 同一条既有排期会同时出现在两路里（小红书且在主题索引内的记录）。
  // 不去重的话，checkDuplicateMinute 会把它自己和自己算成「同一分钟两条」而误拒。
  // 去重键取「平台 + 归一化账号 + 分钟」，保留信息更全的 topic 一路。
  const deduped = new Map();
  for (const reservation of normalized) {
    const key = `${reservation.accountKey} ${reservation.minute}`;
    const existing = deduped.get(key);
    if (!existing || (existing.scope !== 'topic' && reservation.scope === 'topic')) {
      deduped.set(key, reservation);
    }
  }
  return [...deduped.values()];
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return null;
  return value.map(item => String(item || '').trim()).filter(Boolean);
}

// noteFolders 描述本批可用的笔记模板全集：[{topic, templates: [...]}]
// 展开成 noteKey = `${topic}/${template}` 的集合，供校验 schedule 里的 noteKey 是否越界、
// 以及（非部分排期时）是否全部被排上。noteFolders 为可选参数，结构非法时视为调用方接线问题，
// 直接抛错，不进入 schedule 逐项违规收集。
function expandNoteFolders(noteFolders) {
  if (noteFolders === undefined) return null;
  if (!Array.isArray(noteFolders) || noteFolders.length === 0) {
    throw createInputError('noteFolders 必须是非空数组');
  }
  const noteKeys = new Set();
  const topics = [];
  const seenTopics = new Set();
  for (const folder of noteFolders) {
    const topic = String(folder?.topic || '').trim();
    if (!topic) throw createInputError('noteFolders 中存在空 topic');
    const templates = normalizeStringArray(folder.templates);
    if (templates === null) throw createInputError(`noteFolders[${topic}].templates 必须是数组`);
    if (!seenTopics.has(topic)) {
      seenTopics.add(topic);
      topics.push(topic);
    }
    for (const template of templates) {
      noteKeys.add(`${topic}/${template}`);
    }
  }
  if (noteKeys.size === 0) throw createInputError('noteFolders 中没有可调度模板');
  return { noteKeys, topics };
}

// topic / template 各自 trim 后再用于比较：Python 端 build_note_pool 是 strip 过的，
// 校验器不 trim 会出现 "主题2/ x" 与 "主题1/x" 被当成两个模板的单侧漏检。
// compareKey 是归一化后的 noteKey，用于 noteKey 去重与 noteFolders 集合比对；
// 原始 noteKey 只用于报错展示。
function parseNoteKey(noteKey) {
  const text = String(noteKey || '');
  const index = text.lastIndexOf('/');
  if (index <= 0 || index === text.length - 1) return null;
  const topic = text.slice(0, index).trim();
  const template = text.slice(index + 1).trim();
  if (!topic || !template) return null;
  return { topic, template, compareKey: `${topic}/${template}` };
}

// 店铺组只认服务端下发的 accountGroups（账号 → 店铺组），不信客户端 schedule 里的 storeGroup。
function buildStoreGroupIndex(accountGroups) {
  const index = new Map();
  if (accountGroups && typeof accountGroups === 'object' && !Array.isArray(accountGroups)) {
    for (const [account, group] of Object.entries(accountGroups)) {
      const key = normalizeAccountName(account);
      const value = String(group ?? '').trim();
      if (key && value) index.set(key, value);
    }
  }
  return index;
}

// topicKey 只认服务端下发的 currentItems（noteKey → topicKey），不信客户端 schedule 里的 topicKey。
function buildTopicKeyIndex(currentItems) {
  const index = new Map();
  if (Array.isArray(currentItems)) {
    for (const entry of currentItems) {
      const parsed = parseNoteKey(entry?.noteKey);
      const topicKey = String(entry?.topicKey ?? '').trim();
      if (parsed && topicKey) index.set(parsed.compareKey, topicKey);
    }
  }
  return index;
}

// 逐项校验 schedule 里每条记录的基础合法性（rule: format），并把能安全使用的字段
// 挂到返回对象上（timestamp/minute/accountKey/templateInfo），供后续约束复用，避免重复解析。
function normalizeScheduleItems(schedule, context, violations) {
  const normalized = [];
  schedule.forEach((raw, index) => {
    const label = `schedule[${index}]`;
    const platform = String(raw?.platform || '').trim();
    const account = String(raw?.account || '').trim();
    const noteKey = String(raw?.noteKey || '').trim();
    const rawPublishTime = raw?.publishTime;
    const problems = [];
    if (!SUPPORTED_PLATFORMS.has(platform)) problems.push(`platform 必须是 xiaohongshu 或 douyin，实际为 "${raw?.platform}"`);
    if (!account) problems.push('account 不能为空');
    const timestamp = parseStrictTimestamp(rawPublishTime);
    if (timestamp === null) {
      problems.push(`publishTime 无法解析: ${rawPublishTime}`);
    } else if (!EXACT_MINUTE_PATTERN.test(String(rawPublishTime || '').trim())) {
      problems.push(`publishTime 必须是具体到分钟的 "YYYY-MM-DD HH:MM" 格式，实际为 "${rawPublishTime}"`);
    }
    const noteKeyInfo = parseNoteKey(noteKey);
    if (!noteKeyInfo) problems.push(`noteKey 格式必须为 "topic/template"，实际为 "${noteKey}"`);

    if (problems.length > 0) {
      violations.push({ rule: 'format', message: `${label}: ${problems.join('；')}`, items: [label] });
      return;
    }

    // topicKey / storeGroup 一律从服务端下发的权威数据反查，不读 raw.topicKey / raw.storeGroup。
    // 反查不到 storeGroup 时留空，由 checkTopicSpacing 在 auto_space 模式下 fail-closed 记违规。
    const resolvedTopicKey = context.topicKeyByNoteKey.get(noteKeyInfo.compareKey) || noteKeyInfo.topic;
    const resolvedStoreGroup = context.storeGroupByAccount.get(normalizeAccountName(account)) || '';

    normalized.push({
      index,
      label,
      platform,
      account,
      accountKey: `${platform}:${normalizeAccountName(account)}`,
      accountLabel: `${platform}:${account}`,
      noteKey,
      noteKeyCompare: noteKeyInfo.compareKey,
      topic: noteKeyInfo.topic,
      template: noteKeyInfo.template,
      topicKey: resolvedTopicKey,
      topicGroupKey: normalizeGroupKey(resolvedTopicKey),
      storeGroup: resolvedStoreGroup,
      storeGroupKey: normalizeGroupKey(resolvedStoreGroup),
      timestamp,
      minute: formatMinute(timestamp),
    });
  });
  return normalized;
}

function checkMinInterval(items, reservations, minIntervalMinutes, violations) {
  const minIntervalMs = minIntervalMinutes * 60 * 1000;
  const byAccount = new Map();
  const addEntry = entry => {
    if (!byAccount.has(entry.accountKey)) byAccount.set(entry.accountKey, []);
    byAccount.get(entry.accountKey).push(entry);
  };
  for (const item of items) {
    addEntry({ accountKey: item.accountKey, platform: item.platform, account: item.account, timestamp: item.timestamp, label: item.label, isCurrent: true });
  }
  for (const reservation of reservations) {
    addEntry({ accountKey: reservation.accountKey, platform: reservation.platform, account: reservation.account, timestamp: reservation.timestamp, label: reservation.label, isCurrent: false });
  }
  for (const entries of byAccount.values()) {
    const sorted = entries.slice().sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      // 两条都是既有排期时不报违规：那是飞书里已经存在的事实，本批怎么改都消不掉，
      // 报出来只会让整批永远排不出去。本批条目与既有排期撞、或本批内部撞，才是可修复的违规。
      // 排序相邻比较仍能覆盖：若本批条目 I 与某条 X 间隔不足，I 在那一侧的相邻条目 Y
      // 必然夹在两者之间，|I-Y| ≤ |I-X| < 阈值，相邻对 (I,Y) 一定会被记下。
      if (!prev.isCurrent && !curr.isCurrent) continue;
      const diffMinutes = Math.round((curr.timestamp - prev.timestamp) / 60000);
      if (curr.timestamp - prev.timestamp < minIntervalMs) {
        violations.push({
          rule: 'min_interval',
          message: `账号 ${curr.account}（${curr.platform}）：${formatMinute(prev.timestamp)} 与 ${formatMinute(curr.timestamp)} 间隔 ${diffMinutes} 分钟，不足 ${minIntervalMinutes} 分钟`,
          items: [prev.label, curr.label],
        });
      }
    }
  }
}

function checkDuplicateMinute(items, reservations, violations) {
  const byMinute = new Map();
  const addEntry = (minute, label, isCurrent) => {
    if (!byMinute.has(minute)) byMinute.set(minute, { labels: [], currentCount: 0 });
    const bucket = byMinute.get(minute);
    bucket.labels.push(label);
    if (isCurrent) bucket.currentCount += 1;
  };
  for (const item of items) addEntry(item.minute, item.label, true);
  for (const reservation of reservations) addEntry(reservation.minute, reservation.label, false);
  for (const [minute, bucket] of byMinute.entries()) {
    // 与 checkMinInterval 同理：全部由既有排期构成的分钟冲突是飞书里的存量事实，
    // 本批无法通过调整排期消除，不记违规。只要本批占了这一分钟就必须报。
    if (bucket.labels.length > 1 && bucket.currentCount > 0) {
      violations.push({
        rule: 'duplicate_minute',
        message: `发布分钟 ${minute} 被 ${bucket.labels.length} 条记录占用，全局分钟必须唯一：${bucket.labels.join('、')}`,
        items: bucket.labels,
      });
    }
  }
}

function checkDuplicateNoteKey(items, violations) {
  const byPlatform = new Map();
  for (const item of items) {
    if (!byPlatform.has(item.platform)) byPlatform.set(item.platform, new Map());
    const byNoteKey = byPlatform.get(item.platform);
    if (!byNoteKey.has(item.noteKeyCompare)) byNoteKey.set(item.noteKeyCompare, []);
    byNoteKey.get(item.noteKeyCompare).push(item.label);
  }
  for (const [platform, byNoteKey] of byPlatform.entries()) {
    for (const [noteKey, labels] of byNoteKey.entries()) {
      if (labels.length > 1) {
        violations.push({
          rule: 'duplicate_note_key',
          message: `平台 ${platform} 内 noteKey "${noteKey}" 重复出现 ${labels.length} 次：${labels.join('、')}`,
          items: labels,
        });
      }
    }
  }
}

function checkDuplicateTemplate(items, violations) {
  const byAccount = new Map();
  for (const item of items) {
    if (!byAccount.has(item.accountKey)) {
      byAccount.set(item.accountKey, { accountLabel: item.accountLabel, byTemplate: new Map() });
    }
    const { byTemplate } = byAccount.get(item.accountKey);
    if (!byTemplate.has(item.template)) byTemplate.set(item.template, []);
    byTemplate.get(item.template).push(item.label);
  }
  for (const { accountLabel, byTemplate } of byAccount.values()) {
    for (const [template, labels] of byTemplate.entries()) {
      if (labels.length > 1) {
        violations.push({
          rule: 'duplicate_template',
          message: `账号 ${accountLabel} 内模板 "${template}" 重复出现 ${labels.length} 次：${labels.join('、')}`,
          items: labels,
        });
      }
    }
  }
}

// 规则 A（跨店铺同主题跨账号，硬违规）与规则 B（同店铺同主题跨账号，需人工审批）
// 都是"平台内按主题比较"，且都必须无条件执行——旧实现里 `topicDecision !== 'auto_space'`
// 直接 return，导致用户选 allow_conflicts 时这条约束整条失效，是本次要修的核心缺陷之一。
// 抖音同样纳入（旧实现 `entry.platform !== 'xiaohongshu'` 的过滤已删掉）。
// 注意：A/B/C/D 四条规则都只在同一平台内比较，不跨平台比——分组键包含 platform。
function checkTopicSpacing(items, reservations, minCrossStoreIntervalMinutes, violations, approvals) {
  const minIntervalMs = minCrossStoreIntervalMinutes * 60 * 1000;
  const byGroup = new Map();
  // fail-closed：分不出店铺组或主题就记违规，不再静默跳过——分组键缺失等于这条约束整条失效。
  // 调用方（validateImportSchedule）已经把 scope='time'（不带主题信息的平台无关占用）
  // 过滤掉了，这里不会把那一路的抖音/小红书记录误判成"缺主题"。
  const addEntry = entry => {
    if (!entry.storeGroupKey || !entry.topicGroupKey) {
      const missing = [];
      if (!entry.storeGroupKey) missing.push(`账号「${entry.account}」未在 accountGroups 中配置店铺组`);
      if (!entry.topicGroupKey) missing.push('无法确定主题（currentItems 中查不到该 noteKey 对应的 topicKey）');
      violations.push({
        rule: 'topic_spacing',
        message: `${entry.label}: 无法检查跨账号同主题间隔——${missing.join('；')}`,
        items: [entry.label],
      });
      return;
    }
    // 分组键改为「平台 + 主题」，不再含店铺组：跨店铺同主题也要能比到一起，
    // 才谈得上规则 A（跨店铺间隔）；组内再按 storeGroupKey 是否相同分流 A / B。
    const key = `${entry.platform} ${entry.topicGroupKey}`;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(entry);
  };
  const pick = (source, isCurrent) => ({
    platform: source.platform,
    storeGroupKey: source.storeGroupKey,
    topicGroupKey: source.topicGroupKey,
    topicKey: source.topicKey,
    account: source.account,
    accountNameKey: normalizeAccountName(source.account),
    timestamp: source.timestamp,
    label: source.label,
    isCurrent,
  });
  for (const item of items) addEntry(pick(item, true));
  for (const reservation of reservations) addEntry(pick(reservation, false));
  for (const entries of byGroup.values()) {
    const sorted = entries.slice().sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[i].accountNameKey === sorted[j].accountNameKey) continue;
        // 与 checkMinInterval / checkDuplicateMinute 同款豁免：两条都是既有排期时不报。
        // 那是飞书里已经存在的事实，本批怎么排都消不掉，报出来会让整批永远排不出去
        // （实测：飞书里存量的跨店铺同主题记录会累积出上百条 violation，把此后每一批
        // 干净的新排期都拒收）。本批条目与既有排期撞、或本批内部撞，才是可修复的违规。
        if (!sorted[i].isCurrent && !sorted[j].isCurrent) continue;
        const diffMinutes = Math.round(Math.abs(sorted[j].timestamp - sorted[i].timestamp) / 60000);
        if (sorted[i].storeGroupKey === sorted[j].storeGroupKey) {
          // 规则 B：同店铺不同账号发同一主题，不论间隔多久都要走人工审批——不记 violation，
          // 单独进 approvals，由调用方（server.js）带回前端给用户确认。
          approvals.push({
            rule: 'topic_spacing_approval',
            platform: sorted[i].platform,
            topicKey: sorted[i].topicKey || sorted[i].topicGroupKey,
            storeGroup: sorted[i].storeGroupKey,
            accounts: [sorted[i].account, sorted[j].account],
            message: `同店铺同主题跨账号需人工审批：${sorted[i].account}（${formatMinute(sorted[i].timestamp)}）与 ${sorted[j].account}（${formatMinute(sorted[j].timestamp)}）间隔 ${diffMinutes} 分钟`,
            items: [sorted[i].label, sorted[j].label],
          });
        } else if (Math.abs(sorted[j].timestamp - sorted[i].timestamp) < minIntervalMs) {
          // 规则 A：跨店铺不同账号发同一主题，间隔必须 ≥ minCrossStoreTopicIntervalMinutes（2880 分钟/2 天），硬违规。
          violations.push({
            rule: 'topic_spacing',
            message: `跨店铺同主题跨账号：${sorted[i].account}（${formatMinute(sorted[i].timestamp)}）与 ${sorted[j].account}（${formatMinute(sorted[j].timestamp)}）间隔 ${diffMinutes} 分钟，不足 ${minCrossStoreIntervalMinutes} 分钟`,
            items: [sorted[i].label, sorted[j].label],
          });
        }
      }
    }
  }
}

// 规则 C（7 天窗口同主题 > 10 条强制告警）与规则 D（30 天窗口只统计不设阈值）。
// 同一平台内按主题分组，把本批条目和既有排期（reservations 已经是 scope='topic' 一路，
// 带 topicGroupKey）的时间戳合并后，用滑动窗口分别求 7 天/30 天窗口内的最大条数。
// 没有主题信息的条目直接跳过——它们已经在 checkTopicSpacing 里被 fail-closed 记过违规，
// 这里不重复报错，只是不参与统计（避免 undefined topicGroupKey 污染分组）。
function checkTopicVolume(items, reservations, constraints, warnings, topicVolumeStats) {
  const shortWindowMs = constraints.topicVolumeWindowDays * 24 * 60 * 60 * 1000;
  const longWindowMs = constraints.topicVolumeLongWindowDays * 24 * 60 * 60 * 1000;
  const byGroup = new Map();
  const addEntry = entry => {
    if (!entry.topicGroupKey) return;
    const key = `${entry.platform} ${entry.topicGroupKey}`;
    if (!byGroup.has(key)) {
      byGroup.set(key, { platform: entry.platform, topicKey: entry.topicKey || entry.topicGroupKey, timestamps: [] });
    }
    byGroup.get(key).timestamps.push(entry.timestamp);
  };
  for (const item of items) {
    addEntry({ platform: item.platform, topicGroupKey: item.topicGroupKey, topicKey: item.topicKey, timestamp: item.timestamp });
  }
  for (const reservation of reservations) {
    addEntry({ platform: reservation.platform, topicGroupKey: reservation.topicGroupKey, topicKey: reservation.topicKey, timestamp: reservation.timestamp });
  }
  // 滑动窗口最大条数：排序后双指针，O(n) 求"任意长度为 windowMs 的区间内最多几条"。
  const maxCountInWindow = (sortedTimestamps, windowMs) => {
    let left = 0;
    let max = 0;
    for (let right = 0; right < sortedTimestamps.length; right++) {
      while (sortedTimestamps[right] - sortedTimestamps[left] > windowMs) left++;
      max = Math.max(max, right - left + 1);
    }
    return max;
  };
  for (const { platform, topicKey, timestamps } of byGroup.values()) {
    const sorted = timestamps.slice().sort((a, b) => a - b);
    const shortCount = maxCountInWindow(sorted, shortWindowMs);
    const longCount = maxCountInWindow(sorted, longWindowMs);
    topicVolumeStats.push({
      platform,
      topicKey,
      windowDays: constraints.topicVolumeWindowDays,
      count: shortCount,
      longWindowDays: constraints.topicVolumeLongWindowDays,
      longCount,
    });
    if (shortCount > constraints.topicVolumeMaxCount) {
      warnings.push(
        `平台 ${platform} 主题「${topicKey}」在 ${constraints.topicVolumeWindowDays} 天窗口内累计发布 ${shortCount} 条，`
        + `超过上限 ${constraints.topicVolumeMaxCount} 条（超出 ${shortCount - constraints.topicVolumeMaxCount} 条）`
      );
    }
  }
}
function checkNoteFolderCoverage(items, noteFolderInfo, allowPartialSchedule, violations) {
  if (!noteFolderInfo) return;
  const scheduledNoteKeys = new Set(items.map(item => item.noteKeyCompare));
  const missingFromUniverse = items.filter(item => !noteFolderInfo.noteKeys.has(item.noteKeyCompare));
  if (missingFromUniverse.length > 0) {
    violations.push({
      rule: 'note_missing',
      message: `以下 noteKey 不在 noteFolders 声明的模板集合内：${missingFromUniverse.map(item => item.noteKey).join('、')}`,
      items: missingFromUniverse.map(item => item.label),
    });
  }
  if (!allowPartialSchedule) {
    const unscheduled = [...noteFolderInfo.noteKeys].filter(noteKey => !scheduledNoteKeys.has(noteKey));
    if (unscheduled.length > 0) {
      violations.push({
        rule: 'note_missing',
        message: `以下笔记未被排入本次 schedule（未开启部分排期）：${unscheduled.join('、')}`,
        items: unscheduled,
      });
    }
  }
}

function checkCoverageStrategy(items, coverageStrategy, topicsUniverse, violations, warnings) {
  if (coverageStrategy === 'minimum') return;
  if (topicsUniverse.size === 0) return;
  const coveredByAccount = new Map();
  for (const item of items) {
    if (!coveredByAccount.has(item.accountKey)) {
      coveredByAccount.set(item.accountKey, { accountLabel: item.accountLabel, covered: new Set() });
    }
    coveredByAccount.get(item.accountKey).covered.add(item.topicGroupKey);
  }
  for (const { accountLabel, covered } of coveredByAccount.values()) {
    if (covered.size < topicsUniverse.size) {
      const message = `账号 ${accountLabel}：只覆盖 ${covered.size}/${topicsUniverse.size} 个主题`;
      if (coverageStrategy === 'strict') {
        violations.push({ rule: 'coverage', message, items: [accountLabel] });
      } else if (coverageStrategy === 'balanced') {
        warnings.push(message);
      }
    }
  }
}

function validateImportSchedule(input) {
  const constraints = loadConstraints();
  const violations = [];
  const warnings = [];

  if (!Array.isArray(input?.schedule) || input.schedule.length === 0) {
    throw createInputError('schedule 必须是非空数组', [
      { rule: 'format', message: 'schedule 必须是非空数组', items: [] },
    ]);
  }

  const reservations = normalizeExistingReservations(input.existingReservations);
  const coverageStrategy = normalizeCoverageStrategy(input.coverageStrategy);
  // topicDecision（input.topicDecision）不再门控 checkTopicSpacing——规则 A/B 无条件执行，
  // 本函数内部不再读取这个字段；它仍然是 server.js 侧历史确认流程（confirmation.decision）
  // 的输入之一，只是不再传进这里。
  const allowPartialSchedule = input.allowPartialSchedule === true;
  const noteFolderInfo = expandNoteFolders(input.noteFolders);

  // topicKey / storeGroup 的真值都在服务端：currentItems 由 describeCurrentTopics 生成，
  // accountGroups 由 normalizeTopicSpacingInput 强制校验过，客户端 schedule 里的同名字段一律不读。
  const resolveContext = {
    topicKeyByNoteKey: buildTopicKeyIndex(input.currentItems),
    storeGroupByAccount: buildStoreGroupIndex(input.accountGroups),
  };
  const items = normalizeScheduleItems(input.schedule, resolveContext, violations);

  // 后续约束都建立在「格式已合法」的条目上；格式不合法的条目已经单独记为 format 违规。
  checkMinInterval(items, reservations, constraints.minSameAccountIntervalMinutes, violations);
  // 分钟全局唯一是硬约束，没有关闭开关：schedule-constraints.json 里的
  // uniqueMinuteAcrossBatch 只作为回显字段保留，不再决定是否执行本项检查。
  checkDuplicateMinute(items, reservations, violations);
  checkDuplicateNoteKey(items, violations);
  checkDuplicateTemplate(items, violations);
  // 规则 A/B/C/D 只消费带 storeGroup/topicKey 的主题一路（scope='topic'）。
  // 平台无关的时间占用（scope='time'）没有主题信息，进来会被 fail-closed 分支
  // 误记成违规，必须在这里滤掉。
  const topicScopedReservations = reservations.filter(reservation => reservation.scope === 'topic');
  const approvals = [];
  checkTopicSpacing(
    items,
    topicScopedReservations,
    constraints.minCrossStoreTopicIntervalMinutes,
    violations,
    approvals
  );
  const topicVolumeStats = [];
  checkTopicVolume(items, topicScopedReservations, constraints, warnings, topicVolumeStats);
  checkNoteFolderCoverage(items, noteFolderInfo, allowPartialSchedule, violations);

  const topicsUniverse = new Set(
    (noteFolderInfo ? noteFolderInfo.topics : items.map(item => item.topicKey)).map(normalizeGroupKey)
  );
  checkCoverageStrategy(items, coverageStrategy, topicsUniverse, violations, warnings);

  if (violations.length > 0) {
    const message = `排期校验未通过（共 ${violations.length} 项）：${violations.map(v => v.message).join('；')}`;
    throw createInputError(message, violations);
  }

  return {
    ok: true,
    schedule: input.schedule,
    // approvals：规则 B（同店铺同主题跨账号）命中的条目，不是违规，需要人工审批放行。
    // topicVolume：规则 C（7 天窗口告警，已并入 stats.warnings）+ 规则 D（30 天窗口纯统计）的明细。
    approvals,
    topicVolume: topicVolumeStats,
    stats: {
      scheduledCount: input.schedule.length,
      coverageStrategy,
      warnings,
      topicVolumeWindowDays: constraints.topicVolumeWindowDays,
      topicVolumeLongWindowDays: constraints.topicVolumeLongWindowDays,
    },
    constraints: {
      minSameAccountIntervalMinutes: constraints.minSameAccountIntervalMinutes,
      minCrossStoreTopicIntervalMinutes: constraints.minCrossStoreTopicIntervalMinutes,
      topicVolumeWindowDays: constraints.topicVolumeWindowDays,
      topicVolumeMaxCount: constraints.topicVolumeMaxCount,
      topicVolumeLongWindowDays: constraints.topicVolumeLongWindowDays,
      // 无条件为 true：分钟唯一已是不可关闭的硬约束，这里只是保持返回契约不变。
      uniqueMinuteAcrossBatch: true,
      seed: String(input.seed || ''),
    },
  };
}

module.exports = { validateImportSchedule };
