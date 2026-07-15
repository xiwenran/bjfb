const { parsePublishTimestamp } = require('./publish-guard.js');

const MIN_SAME_ACCOUNT_INTERVAL_MINUTES = 361;
const MIN_INTERVAL_MS = MIN_SAME_ACCOUNT_INTERVAL_MINUTES * 60 * 1000;
const SUPPORTED_PLATFORMS = new Set(['xiaohongshu', 'douyin']);

function createInputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function createSeededRandom(seed) {
  let state = 2166136261;
  for (const char of String(seed)) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, rng) {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index--) {
    const target = Math.floor(rng() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function normalizeStringArray(value, fieldName) {
  if (!Array.isArray(value)) throw createInputError(`${fieldName} 必须是数组`);
  return value.map(item => String(item || '').trim()).filter(Boolean);
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

function normalizeNotes(noteFolders, currentItems) {
  if (!Array.isArray(noteFolders) || noteFolders.length === 0) {
    throw createInputError('noteFolders 必须是非空数组');
  }
  const topicByNoteKey = new Map();
  if (Array.isArray(currentItems)) {
    for (const item of currentItems) {
      const noteKey = String(item?.noteKey || '').trim();
      const topicKey = String(item?.topicKey || '').trim();
      if (noteKey && topicKey) topicByNoteKey.set(noteKey, topicKey);
    }
  }

  const notes = [];
  const topics = [];
  const seenTopics = new Set();
  const seenNoteKeys = new Set();
  for (const folder of noteFolders) {
    const topic = String(folder?.topic || '').trim();
    if (!topic) throw createInputError('noteFolders 中存在空 topic');
    const templates = normalizeStringArray(folder.templates, `noteFolders[${topic}].templates`);
    for (const template of templates) {
      const noteKey = `${topic}/${template}`;
      if (seenNoteKeys.has(noteKey)) continue;
      seenNoteKeys.add(noteKey);
      const topicKey = topicByNoteKey.get(noteKey) || topic;
      if (!seenTopics.has(topicKey)) {
        seenTopics.add(topicKey);
        topics.push(topicKey);
      }
      notes.push({ topic, topicKey, template, noteKey });
    }
  }
  if (notes.length === 0) throw createInputError('noteFolders 中没有可调度模板');
  return { notes, topics };
}

function normalizeAccounts(input, rng) {
  const accounts = input?.accounts;
  const timeSlots = input?.timeSlots;
  if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) {
    throw createInputError('accounts 必须是对象');
  }
  if (!timeSlots || typeof timeSlots !== 'object' || Array.isArray(timeSlots)) {
    throw createInputError('timeSlots 必须是对象');
  }
  const regularSlots = normalizeStringArray(timeSlots.regular || [], 'timeSlots.regular');
  const specialSlots = normalizeStringArray(timeSlots.special || [], 'timeSlots.special');
  const accountGroups = input?.accountGroups && typeof input.accountGroups === 'object' && !Array.isArray(input.accountGroups)
    ? input.accountGroups
    : {};
  const definitions = [
    ['xiaohongshu', 'regular', accounts.xiaohongshu_regular || [], regularSlots],
    ['xiaohongshu', 'special', accounts.xiaohongshu_special || [], specialSlots],
    ['douyin', 'regular', accounts.douyin || [], regularSlots],
  ];
  const normalized = [];
  const seenAccountKeys = new Set();
  for (const [platform, slotType, rawAccounts, slots] of definitions) {
    const names = normalizeStringArray(rawAccounts, `accounts.${platform}_${slotType}`);
    if (names.length > 0 && slots.length === 0) {
      throw createInputError(`${slotType} 时段为空，无法调度 ${platform} 账号`);
    }
    for (const account of shuffle(names, rng)) {
      const accountKey = `${platform}:${account}`;
      if (seenAccountKeys.has(accountKey)) throw createInputError(`账号重复: ${accountKey}`);
      seenAccountKeys.add(accountKey);
      const storeGroup = String(accountGroups[account] || '').trim();
      if (platform === 'xiaohongshu' && input.topicDecision === 'auto_space' && !storeGroup) {
        throw createInputError(`小红书账号 ${account} 缺少店铺组映射`);
      }
      normalized.push({ platform, account, accountKey, storeGroup, slots, slotType });
    }
  }
  if (normalized.length === 0) throw createInputError('accounts 中没有可调度账号');
  return shuffle(normalized, rng);
}

function formatMinute(timestamp) {
  const date = new Date(timestamp);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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

function parseWindow(value) {
  const match = String(value || '').trim().match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (!match) return null;
  const start = parseStrictTimestamp(`${match[1]} ${match[2]}`);
  const end = parseStrictTimestamp(`${match[1]} ${match[3]}`);
  if (start === null || end === null || end < start) throw createInputError(`时间窗无效: ${value}`);
  return { start, end };
}

function buildSegments(slotValue, count, rng) {
  const window = parseWindow(slotValue);
  if (!window) {
    const timestamp = parseStrictTimestamp(slotValue);
    if (timestamp === null) throw createInputError(`发布时间无法解析: ${slotValue}`);
    if (count !== 1) {
      throw createInputError(`精确分钟槽 ${slotValue} 不足：需要 ${count} 个唯一分钟，只有 1 个`);
    }
    return [[timestamp]];
  }
  const totalMinutes = Math.floor((window.end - window.start) / 60000) + 1;
  if (totalMinutes < count) {
    throw createInputError(`时间窗 ${slotValue} 的唯一分钟不足：需要 ${count}，只有 ${totalMinutes}`);
  }
  const segments = [];
  for (let index = 0; index < count; index++) {
    const segmentStart = Math.floor(index * totalMinutes / count);
    const segmentEnd = Math.floor((index + 1) * totalMinutes / count) - 1;
    const length = segmentEnd - segmentStart + 1;
    const startOffset = Math.floor(rng() * length);
    const candidates = [];
    for (let offset = 0; offset < length; offset++) {
      const minuteOffset = segmentStart + ((startOffset + offset) % length);
      candidates.push(window.start + minuteOffset * 60000);
    }
    segments.push(candidates);
  }
  return shuffle(segments, rng);
}

function normalizeExistingReservations(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw createInputError('existingReservations 必须是数组');
  return value.map(item => {
    const platform = String(item?.platform || '').trim();
    const account = String(item?.account || '').trim();
    const timestamp = parseStrictTimestamp(item?.publishTime);
    if (!SUPPORTED_PLATFORMS.has(platform) || !account || timestamp === null) {
      throw createInputError('已有排期记录缺少合法 platform、account 或 publishTime');
    }
    return {
      platform,
      account,
      accountKey: `${platform}:${account}`,
      timestamp,
      topicKey: String(item?.topicKey || '').trim(),
      storeGroup: String(item?.storeGroup || '').trim(),
    };
  });
}

function canPlaceAccountTime(times, candidate) {
  return (times || []).every(existing => Math.abs(candidate - existing) >= MIN_INTERVAL_MS);
}

function allocateImportSchedule(input) {
  const seed = String(input?.seed || '').trim();
  if (!seed) throw createInputError('seed 不能为空，排期必须可复算');
  const rng = createSeededRandom(seed);
  const { notes, topics } = normalizeNotes(input?.noteFolders, input?.currentItems);
  const accounts = normalizeAccounts(input, rng);
  const reservations = normalizeExistingReservations(input?.existingReservations);
  const coverageStrategy = normalizeCoverageStrategy(input?.coverageStrategy);
  const perAccountPerSlot = Number.isInteger(input?.perAccountPerSlot) && input.perAccountPerSlot > 0
    ? input.perAccountPerSlot
    : 1;

  const poolsByValue = new Map();
  for (const account of accounts) {
    for (const slot of account.slots) {
      if (!poolsByValue.has(slot)) poolsByValue.set(slot, { value: slot, tasks: [] });
      const pool = poolsByValue.get(slot);
      for (let copy = 0; copy < perAccountPerSlot; copy++) {
        pool.tasks.push({ ...account, placementIndex: copy });
      }
    }
  }

  const tasks = [];
  for (const pool of poolsByValue.values()) {
    pool.segments = buildSegments(pool.value, pool.tasks.length, rng);
    pool.usedSegments = new Set();
    for (const task of shuffle(pool.tasks, rng)) tasks.push({ ...task, pool });
  }
  const orderedTasks = shuffle(tasks, rng);

  const usedMinutes = new Set();
  const accountTimes = new Map();
  const topicTimes = new Map();
  for (const reservation of reservations) {
    if (!accountTimes.has(reservation.accountKey)) accountTimes.set(reservation.accountKey, []);
    accountTimes.get(reservation.accountKey).push(reservation.timestamp);
    if (reservation.platform === 'xiaohongshu' && reservation.storeGroup && reservation.topicKey) {
      const key = `${reservation.storeGroup}\u0000${reservation.topicKey}`;
      if (!topicTimes.has(key)) topicTimes.set(key, []);
      topicTimes.get(key).push({ timestamp: reservation.timestamp, account: reservation.account });
    }
  }

  const usedNotesByPlatform = new Map([
    ['xiaohongshu', new Set()],
    ['douyin', new Set()],
  ]);
  const usedTemplatesByAccount = new Map();
  const usedAnyNotes = new Set();
  const coveredTopicsByAccount = new Map();
  const schedule = [];
  const noteOrder = shuffle(notes, rng);

  function candidateNotes(task) {
    const startTopic = (orderedTasks.indexOf(task) + task.placementIndex) % topics.length;
    const topicOrder = topics.slice(startTopic).concat(topics.slice(0, startTopic));
    const topicRank = new Map(topicOrder.map((topic, index) => [topic, index]));
    return noteOrder.slice().sort((left, right) => topicRank.get(left.topicKey) - topicRank.get(right.topicKey));
  }

  function search(taskIndex) {
    if (taskIndex === orderedTasks.length) {
      if (notes.some(note => !usedAnyNotes.has(note.noteKey))) return false;
      if (coverageStrategy === 'strict' && accounts.some(account => (
        (coveredTopicsByAccount.get(account.accountKey) || new Set()).size < topics.length
      ))) return false;
      return true;
    }
    const task = orderedTasks[taskIndex];
    const platformNotes = usedNotesByPlatform.get(task.platform);
    const accountTemplates = usedTemplatesByAccount.get(task.accountKey) || new Set();
    const maxSegmentLength = Math.max(...task.pool.segments.map(segment => segment.length));
    for (let candidateIndex = 0; candidateIndex < maxSegmentLength; candidateIndex++) {
      for (let segmentIndex = 0; segmentIndex < task.pool.segments.length; segmentIndex++) {
        if (task.pool.usedSegments.has(segmentIndex)) continue;
        const timestamp = task.pool.segments[segmentIndex][candidateIndex];
        if (timestamp === undefined) continue;
        const minute = formatMinute(timestamp);
        if (usedMinutes.has(minute)) continue;
        const times = accountTimes.get(task.accountKey) || [];
        if (!canPlaceAccountTime(times, timestamp)) continue;
        for (const note of candidateNotes(task)) {
          if (platformNotes.has(note.noteKey) || accountTemplates.has(note.template)) continue;
          const topicKey = `${task.storeGroup}\u0000${note.topicKey}`;
          const tracksTopic = task.platform === 'xiaohongshu' && Boolean(task.storeGroup);
          const relevantTopicTimes = topicTimes.get(topicKey) || [];
          if (task.platform === 'xiaohongshu' && input.topicDecision === 'auto_space' && relevantTopicTimes.some(item => (
            item.account !== task.account && Math.abs(timestamp - item.timestamp) < MIN_INTERVAL_MS
          ))) continue;

          task.pool.usedSegments.add(segmentIndex);
          usedMinutes.add(minute);
          times.push(timestamp);
          accountTimes.set(task.accountKey, times);
          platformNotes.add(note.noteKey);
          accountTemplates.add(note.template);
          usedTemplatesByAccount.set(task.accountKey, accountTemplates);
          usedAnyNotes.add(note.noteKey);
          if (!coveredTopicsByAccount.has(task.accountKey)) coveredTopicsByAccount.set(task.accountKey, new Set());
          coveredTopicsByAccount.get(task.accountKey).add(note.topicKey);
          if (tracksTopic) {
            if (!topicTimes.has(topicKey)) topicTimes.set(topicKey, []);
            topicTimes.get(topicKey).push({ timestamp, account: task.account });
          }
          schedule.push({
            topic: note.topic,
            topicKey: note.topicKey,
            noteKey: note.noteKey,
            platform: task.platform,
            account: task.account,
            storeGroup: task.storeGroup,
            publishTime: minute,
          });

          if (search(taskIndex + 1)) return true;

          schedule.pop();
          if (tracksTopic) topicTimes.get(topicKey).pop();
          const covered = coveredTopicsByAccount.get(task.accountKey);
          if (!schedule.some(item => `${item.platform}:${item.account}` === task.accountKey && item.topicKey === note.topicKey)) {
            covered.delete(note.topicKey);
          }
          if (!schedule.some(item => item.noteKey === note.noteKey)) usedAnyNotes.delete(note.noteKey);
          accountTemplates.delete(note.template);
          platformNotes.delete(note.noteKey);
          times.pop();
          usedMinutes.delete(minute);
          task.pool.usedSegments.delete(segmentIndex);
        }
      }
    }
    return false;
  }

  if (!search(0)) {
    throw createInputError('给定时间资源无法安排全部笔记：同账号必须至少间隔 361 分钟、全局分钟不能重复，且自动错开时同店同主题也须至少间隔 361 分钟');
  }
  const unscheduled = notes.filter(note => !usedAnyNotes.has(note.noteKey)).map(note => note.noteKey);
  if (unscheduled.length > 0) {
    throw createInputError(`给定时间资源无法安排全部笔记：仍有 ${unscheduled.length} 篇未排`);
  }

  const violations = [];
  const warnings = [];
  for (const account of accounts) {
    const coveredCount = (coveredTopicsByAccount.get(account.accountKey) || new Set()).size;
    if (coveredCount < topics.length) {
      const message = `${account.account}：只覆盖 ${coveredCount}/${topics.length} 个主题`;
      if (coverageStrategy === 'strict') violations.push(message);
      if (coverageStrategy === 'balanced') warnings.push(message);
    }
  }
  if (violations.length > 0) throw createInputError(`给定时间资源无法满足严格覆盖：${violations.join('；')}`);

  schedule.sort((left, right) => left.publishTime.localeCompare(right.publishTime) || left.platform.localeCompare(right.platform) || left.account.localeCompare(right.account));
  return {
    schedule,
    unscheduled: [],
    stats: {
      scheduledCount: schedule.length,
      unscheduledCount: 0,
      coverageStrategy,
      violations: [],
      warnings,
    },
    constraints: {
      minSameAccountIntervalMinutes: MIN_SAME_ACCOUNT_INTERVAL_MINUTES,
      uniqueMinuteAcrossBatch: true,
      seed,
    },
  };
}

module.exports = { allocateImportSchedule };
