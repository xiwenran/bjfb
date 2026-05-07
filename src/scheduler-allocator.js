function createInputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function shuffle(items) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function normalizeStringArray(value, fieldName) {
  if (!Array.isArray(value)) throw createInputError(`${fieldName} 必须是数组`);
  return value.map(item => String(item || '').trim()).filter(Boolean);
}

function normalizeNotes(noteFolders) {
  if (!Array.isArray(noteFolders) || noteFolders.length === 0) {
    throw createInputError('noteFolders 必须是非空数组');
  }

  const notes = [];
  const topics = [];
  const templatesByTopic = new Map();
  const seenNoteKeys = new Set();

  for (const folder of noteFolders) {
    const topic = String(folder?.topic || '').trim();
    if (!topic) throw createInputError('noteFolders 中存在空 topic');
    const templates = normalizeStringArray(folder.templates, `noteFolders[${topic}].templates`);
    if (templates.length === 0) continue;

    if (!templatesByTopic.has(topic)) {
      topics.push(topic);
      templatesByTopic.set(topic, []);
    }

    for (const template of templates) {
      const noteKey = `${topic}/${template}`;
      if (seenNoteKeys.has(noteKey)) continue;
      seenNoteKeys.add(noteKey);
      templatesByTopic.get(topic).push(template);
      notes.push({ topic, template, noteKey });
    }
  }

  if (notes.length === 0) throw createInputError('noteFolders 中没有可调度模板');
  return { notes, topics, templatesByTopic };
}

function normalizeAccounts(accounts, timeSlots) {
  if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) {
    throw createInputError('accounts 必须是对象');
  }
  if (!timeSlots || typeof timeSlots !== 'object' || Array.isArray(timeSlots)) {
    throw createInputError('timeSlots 必须是对象');
  }

  const regularSlots = normalizeStringArray(timeSlots.regular || [], 'timeSlots.regular');
  const specialSlots = normalizeStringArray(timeSlots.special || [], 'timeSlots.special');
  const accountGroups = [
    {
      platform: 'xiaohongshu',
      slotType: 'regular',
      accounts: normalizeStringArray(accounts.xiaohongshu_regular || [], 'accounts.xiaohongshu_regular'),
      slots: regularSlots,
    },
    {
      platform: 'xiaohongshu',
      slotType: 'special',
      accounts: normalizeStringArray(accounts.xiaohongshu_special || [], 'accounts.xiaohongshu_special'),
      slots: specialSlots,
    },
    {
      platform: 'douyin',
      slotType: 'regular',
      accounts: normalizeStringArray(accounts.douyin || [], 'accounts.douyin'),
      slots: regularSlots,
    },
  ];

  const normalized = [];
  for (const group of accountGroups) {
    if (group.accounts.length > 0 && group.slots.length === 0) {
      throw createInputError(`${group.slotType} 时段为空，无法调度 ${group.platform} 账号`);
    }
    for (const account of shuffle(group.accounts)) {
      normalized.push({ platform: group.platform, account, slots: group.slots });
    }
  }

  if (normalized.length === 0) throw createInputError('accounts 中没有可调度账号');
  return shuffle(normalized);
}

function buildTopicPlan(topics, totalCount, accountIndex) {
  const shuffledTopics = shuffle(topics);
  const plan = [];
  for (let i = 0; i < totalCount; i++) {
    plan.push(shuffledTopics[(i + accountIndex) % shuffledTopics.length]);
  }
  return plan;
}

function chooseNote(topic, templatesByTopic, usedNoteKeys, usedAccountTemplates) {
  const templates = shuffle(templatesByTopic.get(topic) || []);
  for (const template of templates) {
    const noteKey = `${topic}/${template}`;
    if (usedNoteKeys.has(noteKey) || usedAccountTemplates.has(template)) continue;
    return { topic, template, noteKey };
  }
  return null;
}

function allocateImportSchedule(input) {
  const { topics, templatesByTopic, notes } = normalizeNotes(input?.noteFolders);
  const accounts = normalizeAccounts(input?.accounts, input?.timeSlots);
  const perAccountPerSlot = Number.isInteger(input?.perAccountPerSlot) && input.perAccountPerSlot > 0
    ? input.perAccountPerSlot
    : 1;

  const schedule = [];
  const usedNoteKeys = new Set();
  const accountTopics = new Map();
  const accountTemplates = new Map();
  const accountSlotCounts = new Map();

  accounts.forEach((accountInfo, accountIndex) => {
    const accountKey = `${accountInfo.platform}:${accountInfo.account}`;
    const usedAccountTemplates = new Set();
    const totalForAccount = accountInfo.slots.length * perAccountPerSlot;
    const topicPlan = buildTopicPlan(topics, totalForAccount, accountIndex);

    for (let slotIndex = 0; slotIndex < accountInfo.slots.length; slotIndex++) {
      for (let slotCopy = 0; slotCopy < perAccountPerSlot; slotCopy++) {
        const planIndex = slotIndex * perAccountPerSlot + slotCopy;
        const preferredTopics = [
          topicPlan[planIndex],
          ...shuffle(topics.filter(topic => topic !== topicPlan[planIndex])),
        ];
        const note = preferredTopics
          .map(topic => chooseNote(topic, templatesByTopic, usedNoteKeys, usedAccountTemplates))
          .find(Boolean);

        if (!note) continue;

        usedNoteKeys.add(note.noteKey);
        usedAccountTemplates.add(note.template);
        if (!accountTopics.has(accountKey)) accountTopics.set(accountKey, new Set());
        if (!accountTemplates.has(accountKey)) accountTemplates.set(accountKey, []);
        accountTopics.get(accountKey).add(note.topic);
        accountTemplates.get(accountKey).push(note.template);

        const slotKey = `${accountKey}:${accountInfo.slots[slotIndex]}`;
        accountSlotCounts.set(slotKey, (accountSlotCounts.get(slotKey) || 0) + 1);
        schedule.push({
          topic: note.topic,
          noteKey: note.noteKey,
          platform: accountInfo.platform,
          account: accountInfo.account,
          publishTime: accountInfo.slots[slotIndex],
        });
      }
    }
  });

  const unscheduled = notes
    .filter(note => !usedNoteKeys.has(note.noteKey))
    .map(note => note.noteKey);

  const violations = [];
  for (const accountInfo of accounts) {
    const accountKey = `${accountInfo.platform}:${accountInfo.account}`;
    const coveredTopics = accountTopics.get(accountKey) || new Set();
    const templates = accountTemplates.get(accountKey) || [];
    const duplicateTemplates = templates.filter((template, index) => templates.indexOf(template) !== index);

    if (coveredTopics.size < topics.length) {
      violations.push(`${accountInfo.account}：只覆盖 ${coveredTopics.size}/${topics.length} 个主题`);
    }
    if (duplicateTemplates.length > 0) {
      violations.push(`${accountInfo.account}：模板重复 ${Array.from(new Set(duplicateTemplates)).join(',')}`);
    }
    for (const slot of accountInfo.slots) {
      const count = accountSlotCounts.get(`${accountKey}:${slot}`) || 0;
      if (count > perAccountPerSlot) {
        violations.push(`${accountInfo.account}：${slot} 超过 ${perAccountPerSlot} 篇`);
      } else if (count < perAccountPerSlot) {
        violations.push(`${accountInfo.account}：${slot} 只安排 ${count}/${perAccountPerSlot} 篇`);
      }
    }
  }

  return {
    schedule,
    unscheduled,
    stats: {
      scheduledCount: schedule.length,
      unscheduledCount: unscheduled.length,
      violations,
    },
  };
}

module.exports = {
  allocateImportSchedule,
};
