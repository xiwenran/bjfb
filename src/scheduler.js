const fs = require('fs');
const path = require('path');
const FeishuClient = require('./feishu.js');
const publisher = require('./publisher.js');
const { mapWithConcurrency } = require('./async-utils.js');
const {
  updateYixiaoerAccountCache,
  buildDesiredAccountNamesFromRecords,
  autoMapAccountMappings,
} = require('./account-mapping.js');
const { getRecordTempDir, isFeishuConfigured, saveConfig, readAiWritingCache, saveAiWritingCache } = require('./config-store.js');
const { generateContent } = require('./ai-writer.js');
const DEFAULT_RECENT_RECORD_GUARD_MS = 24 * 60 * 60 * 1000;
const VIDEO_FILE_RE = /\.(mp4|mov|m4v|avi|wmv|flv|mkv|webm|mpeg|mpg|ts|m2ts|rmvb)$/i;

class Scheduler {
  constructor(config) {
    this.config = config;
    this.feishu = new FeishuClient(config.feishu);
    this.running = false;
    this.scanTimer = null;
    this.scheduledTasks = new Map();
    this.logs = [];
    this.maxLogs = 200;
    this.onLog = null;
    this.publishing = false;
    this.activePublishReason = null;
    this.stopRequested = false;
    this.pendingPublishRecords = new Map();
    this.processingRecordIds = new Set();
    this.recentlyPublishedRecords = new Map();
    this.currentProgress = {
      active: false,
      stage: 'idle',
      title: '',
      recordId: '',
      platform: '',
      account: '',
      detail: '等待任务',
      updatedAt: null,
    };
  }

  shouldAbortQueuedWork(reason) {
    return reason !== 'manual' && this.stopRequested;
  }

  log(level, message) {
    const entry = {
      time: new Date().toLocaleString('zh-CN'),
      level,
      message,
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) this.logs.shift();
    console.log(`[${entry.time}] [${level}] ${message}`);
    if (this.onLog) this.onLog(entry);
  }

  setProgress(progress = {}) {
    this.currentProgress = {
      ...this.currentProgress,
      ...progress,
      updatedAt: new Date().toLocaleString('zh-CN'),
    };
    if (typeof this.onProgress === 'function') {
      this.onProgress(this.currentProgress);
    }
  }

  // 从多个时间段生成所有检查时间点
  getAllCheckTimes() {
    const periods = this.config.schedule.periods || [];
    const times = [];
    for (const period of periods) {
      const [startH, startM] = period.startTime.split(':').map(Number);
      const [endH, endM] = period.endTime.split(':').map(Number);
      const interval = period.intervalMinutes || 30;
      const startMin = startH * 60 + startM;
      const endMin = endH * 60 + endM;
      for (let t = startMin; t <= endMin; t += interval) {
        times.push(t);
      }
    }
    // 去重并排序
    return [...new Set(times)].sort((a, b) => a - b);
  }

  getNextCheckTime() {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const allTimes = this.getAllCheckTimes();

    if (allTimes.length === 0) {
      // 没有配置时间段，默认1小时后
      const next = new Date(now);
      next.setHours(next.getHours() + 1, 0, 0, 0);
      return next;
    }

    const today = this.formatLocalDate(now);

    // 找今天剩余的下一个时间点
    for (const t of allTimes) {
      if (t > currentMinutes) {
        const h = Math.floor(t / 60);
        const m = t % 60;
        return new Date(`${today}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`);
      }
    }

    // 今天已过，取明天第一个时间点
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = this.formatLocalDate(tomorrow);
    const first = allTimes[0];
    const h = Math.floor(first / 60);
    const m = first % 60;
    return new Date(`${tomorrowStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`);
  }

  getScheduledTaskKey(recordId, publishTime) {
    const ts = publishTime instanceof Date ? publishTime.getTime() : new Date(publishTime).getTime();
    return `${recordId}:${ts}`;
  }

  clearScheduledTasks() {
    for (const task of this.scheduledTasks.values()) {
      clearTimeout(task.timer);
    }
    this.scheduledTasks.clear();
  }

  formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  findVideoPath(filePaths = []) {
    return filePaths.find(filePath => VIDEO_FILE_RE.test(filePath)) || filePaths[0] || null;
  }

  isPlatformPending(status) {
    return status === '待发布';
  }

  recordHasPendingPlatform(record) {
    const xhsPending = record.xiaohongshuAccount && this.isPlatformPending(record.xiaohongshuStatus);
    const dyPending = record.douyinAccount && this.isPlatformPending(record.douyinStatus);
    return Boolean(xhsPending || dyPending);
  }

  recordHasPublishablePlatform(record) {
    return this.recordHasPendingPlatform(record);
  }

  recordHasContent(record) {
    if (!record.title) return false;
    if (!Array.isArray(record.attachments) || record.attachments.length === 0) return false;
    return true;
  }

  async runAiWriting(records) {
    const AI_WINDOW_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    let cache;
    try {
      cache = readAiWritingCache();
    } catch (e) {
      cache = {};
    }

    // 健康检查：有主题但全部缺 modifiedTime → 飞书 API 可能未返回 last_modified_time
    // （automatic_fields 在该租户/表失效，或字段语义变更）。大声报警，避免静默失败。
    const recordsWithTopic = records.filter(r => r.topic);
    if (recordsWithTopic.length > 0 && recordsWithTopic.every(r => !r.modifiedTime)) {
      this.log('warn', `⚠️ AI 写作健康检查：${recordsWithTopic.length} 条带主题记录全部缺 modifiedTime，可能飞书未返回 last_modified_time。本轮回落用 createdTime 判定时间窗口`);
    }

    const candidates = records.filter(r => {
      if (!r.topic) return false;
      // 时间窗口判定：modifiedTime 优先，缺失时 fallback 到 createdTime（防 last_modified_time 缺失导致全静默）
      const ts = r.modifiedTime || r.createdTime || 0;
      if (ts > 0 && ts < now - AI_WINDOW_MS) return false;
      // 笔记主题与上次生成时相同则跳过
      const cached = cache[r.recordId];
      if (cached && cached.topic === r.topic) return false;
      return true;
    });

    if (candidates.length === 0) return;

    this.log('info', `✍️ AI 写作：发现 ${candidates.length} 条待生成记录`);
    const aiConfig = this.config.aiWriting;

    // 预取字段列表，只写实际存在的字段，避免 FieldNameNotFound
    let tableFieldSet = new Set();
    try {
      const fieldNames = await this.feishu.getTableFields();
      tableFieldSet = new Set(Array.isArray(fieldNames) ? fieldNames : []);
    } catch (_) { /* 获取失败则跳过字段过滤，让 updateRecord 自行报错 */ }

    for (const record of candidates) {
      try {
        const result = await generateContent(aiConfig, record);
        const tagsStr = Array.isArray(result.tags) ? result.tags.join('\n') : '';
        const fields = {};
        if (!tableFieldSet.size || tableFieldSet.has('标题')) fields['标题'] = result.title;
        if (!tableFieldSet.size || tableFieldSet.has('正文')) fields['正文'] = result.description;
        if (!tableFieldSet.size || tableFieldSet.has('标签')) fields['标签'] = tagsStr;
        if (Object.keys(fields).length > 0) {
          await this.feishu.updateRecord(record.recordId, fields);
        } else if (tableFieldSet.size > 0) {
          this.log('warn', `⚠️ AI 写作：飞书表格中未找到「标题/正文/标签」字段，生成内容无法回写，已跳过（${record.recordId}）`);
        }
        // 就地更新内存对象，使本轮 recordHasContent 检查能看到新生成的标题
        record.title = result.title;
        record.description = result.description;
        cache[record.recordId] = { topic: record.topic, generatedAt: new Date().toISOString() };
        this.log('info', `✅ AI 写作完成：《${result.title}》`);
      } catch (e) {
        this.log('warn', `⚠️ AI 写作失败（${record.recordId}）：${e.message}`);
        // 不更新缓存，下次扫描重试
      }
    }

    try {
      saveAiWritingCache(cache);
    } catch (e) {
      this.log('warn', `⚠️ AI 写作缓存保存失败：${e.message}`);
    }
  }

  shouldUseYixiaoer(record) {
    const xhsNeedsYixiaoer = record.xiaohongshuAccount
      && this.isPlatformPending(record.xiaohongshuStatus)
      && record.xiaohongshuPublishChannel !== '比特浏览器';
    const dyNeedsYixiaoer = record.douyinAccount && this.isPlatformPending(record.douyinStatus);
    return Boolean(xhsNeedsYixiaoer || dyNeedsYixiaoer);
  }

  // 解析备注中的平台发布状态
  parsePlatformStatus(note) {
    const result = { xiaohongshu: null, douyin: null };
    if (!note) return result;
    if (note.includes('小红书发布成功') || note.includes('小红书:已发布')) result.xiaohongshu = 'success';
    if (note.includes('抖音发布成功') || note.includes('抖音:已发布')) result.douyin = 'success';
    if (note.includes('小红书') && note.includes('失败')) result.xiaohongshu = result.xiaohongshu || 'failed';
    if (note.includes('抖音') && note.includes('失败')) result.douyin = result.douyin || 'failed';
    return result;
  }

  mergeNoteEntry(note, entry) {
    const normalized = (note || '').trim();
    if (!entry) return normalized;
    if (!normalized) return entry;
    if (normalized.includes(entry)) return normalized;
    return `${normalized}\n${entry}`;
  }

  formatTaskEntry(result) {
    if (!result || !result.taskMeta) return '';
    const prefix = result.publishMode === '比特浏览器发布' ? '比特浏览器' : '蚁小二';
    const parts = [
      `${result.platform}任务已提交(${result.account})`,
      result.publishMode || '',
      result.taskMeta.taskId ? `任务ID:${result.taskMeta.taskId}` : '',
      result.taskMeta.browserId ? `BrowserID:${result.taskMeta.browserId}` : '',
      `时间:${new Date().toLocaleString('zh-CN')}`,
    ].filter(Boolean);
    return `${prefix}${parts.join(' | ')}`;
  }

  formatPublishRecordEntry(record, platformName) {
    if (!record) return '';
    const parts = [
      `蚁小二发布记录`,
      platformName || (Array.isArray(record.platforms) ? record.platforms.join(',') : ''),
      record.nickName ? `账号:${record.nickName}` : '',
      record.createdAt ? `时间:${new Date(record.createdAt).toLocaleString('zh-CN')}` : '',
      record.id ? `记录ID:${record.id}` : '',
    ].filter(Boolean);
    return parts.join(' | ');
  }

  async findLatestPublishRecord(result, title) {
    if (!result || !result.success || result.skipped) return null;
    if (result.publishMode === '比特浏览器发布') return null;

    try {
      const records = await publisher.getPublishRecords({ page: 1, size: 30 });
      return records.find(item => {
        const samePlatform = Array.isArray(item.platforms) && item.platforms.includes(result.platform);
        const sameTitle = !title || !item.title || item.title === title;
        const sameAccount = !result.accountId || item.platformAccountId === result.accountId || item.nickName === result.account;
        return samePlatform && sameTitle && sameAccount;
      }) || null;
    } catch (e) {
      this.log('info', `⚠️ 获取蚁小二发布记录失败: ${e.message}`);
      return null;
    }
  }

  requiresYixiaoerLogin(records) {
    return records.some(record => this.shouldUseYixiaoer(record));
  }

  ensureFeishuConfigured() {
    if (isFeishuConfigured(this.config)) return;
    throw new Error('请先在“飞书接入”页完成 App ID、App Secret、App Token、Table ID 配置');
  }

  async loadCurrentPendingRecord(recordId) {
    this.ensureFeishuConfigured();
    const records = await this.feishu.getUnpublishedRecords();
    const parsed = records.map(r => this.feishu.parseRecord(r));
    return parsed.find(item => item.recordId === recordId) || null;
  }

  getPublishConcurrency() {
    return Math.max(1, Number(this.config.rules?.publishRecordConcurrency) || 2);
  }

  getRecentRecordGuardMs() {
    return Math.max(0, Number(this.config.rules?.recentPublishedRecordGuardMs) || DEFAULT_RECENT_RECORD_GUARD_MS);
  }

  pruneRecentlyPublishedRecords(now = Date.now()) {
    const guardMs = this.getRecentRecordGuardMs();
    for (const [recordId, timestamp] of this.recentlyPublishedRecords.entries()) {
      if (now - timestamp >= guardMs) {
        this.recentlyPublishedRecords.delete(recordId);
      }
    }
  }

  markRecordRecentlyPublished(recordId, now = Date.now()) {
    if (!recordId) return;
    this.recentlyPublishedRecords.set(recordId, now);
  }

  isRecordRecentlyPublished(recordId, now = Date.now()) {
    this.pruneRecentlyPublishedRecords(now);
    if (!recordId) return false;
    return this.recentlyPublishedRecords.has(recordId);
  }

  enqueuePublishRecords(records = [], options = {}) {
    const allowRecentPublished = options.allowRecentPublished === true;
    let queued = 0;
    for (const record of records) {
      if (!record || !record.recordId) continue;
      if (!this.recordHasPublishablePlatform(record)) continue;
      if (this.processingRecordIds.has(record.recordId)) continue;
      if (!allowRecentPublished && this.isRecordRecentlyPublished(record.recordId)) continue;
      const hadRecord = this.pendingPublishRecords.has(record.recordId);
      this.pendingPublishRecords.set(record.recordId, record);
      if (!hadRecord) queued += 1;
    }
    return queued;
  }

  takeQueuedPublishRecords() {
    const records = Array.from(this.pendingPublishRecords.values());
    this.pendingPublishRecords.clear();
    return records;
  }

  async syncAccountMappingsForRecords(records = []) {
    if (!this.requiresYixiaoerLogin(records)) return;

    const accounts = await publisher.getAccountList();
    let configChanged = false;

    const cacheResult = updateYixiaoerAccountCache(this.config, accounts, publisher.collectAccountAliases);
    configChanged = configChanged || cacheResult.changed;

    const desiredNames = buildDesiredAccountNamesFromRecords(records);
    const mappingResult = autoMapAccountMappings(this.config, desiredNames, accounts, publisher.collectAccountAliases);
    configChanged = configChanged || mappingResult.changed;

    if (configChanged) {
      saveConfig(this.config);
    }
  }

  async processSingleRecord(record, options = {}) {
    this.setProgress({
      active: true,
      stage: 'preparing',
      title: record.title,
      recordId: record.recordId,
      platform: '',
      account: '',
      detail: `正在准备记录《${record.title}》`,
    });
    this.log('info', `📝 处理: "${record.title}"`);

    const pendingPlatforms = [];
    if (record.xiaohongshuAccount && this.isPlatformPending(record.xiaohongshuStatus)) {
      pendingPlatforms.push('小红书');
    }
    if (record.douyinAccount && this.isPlatformPending(record.douyinStatus)) {
      pendingPlatforms.push('抖音');
    }

    // P0.3 处理前预检本地账本：所有待发布平台都已在账本中 → 补写飞书状态后跳过
    // 修复（Codex adversarial review）：早返前必须补写飞书"已发布"状态，否则记录会永远
    // 卡在"待发布"列表里被反复扫描。补写状态本身不会触发重复发布——账本已记录是真理。
    if (pendingPlatforms.length > 0
        && pendingPlatforms.every(p => publisher.isAlreadyPublished(record.recordId, p))) {
      this.log('warn', `⏭ 跳过《${record.title}》：所有待发布平台均已在本地账本（防重复保护），补写飞书状态`);
      let nextNote = record.note || '';
      let noteChanged = false;
      for (const platform of pendingPlatforms) {
        try {
          await this.feishu.markPlatformStatus(record.recordId, platform, '已发布');
          const entry = `${platform}状态补正：本地账本已记录为已发布，飞书状态已同步`;
          nextNote = this.mergeNoteEntry(nextNote, entry);
          noteChanged = true;
          this.log('info', `  ✅ ${platform} 状态已补写为"已发布"（来源：本地账本）`);
        } catch (markErr) {
          this.log('error', `  ❌ ${platform} 状态补写失败: ${markErr.message}`);
        }
      }
      if (noteChanged) {
        try {
          await this.feishu.setNote(record.recordId, nextNote);
        } catch (noteErr) {
          this.log('warn', `  ⚠️ 备注同步失败: ${noteErr.message}`);
        }
      }
      try {
        await this.feishu.markPublished(record.recordId);
      } catch (markErr) {
        this.log('warn', `  ⚠️ 整体已发布状态同步失败: ${markErr.message}`);
      }
      this.markRecordRecentlyPublished(record.recordId);
      this.setProgress({
        active: false,
        stage: 'idle',
        title: '',
        recordId: '',
        platform: '',
        account: '',
        detail: `跳过《${record.title}》（账本已记录，状态已补写）`,
      });
      return { published: 0, failed: 0 };
    }

    const tmpDir = getRecordTempDir(record.recordId);
    try {
      this.setProgress({
        active: true,
        stage: 'downloading',
        title: record.title,
        recordId: record.recordId,
        detail: `正在下载《${record.title}》的素材`,
      });
      const attachmentPaths = await this.feishu.downloadAllAttachments(record.attachments, tmpDir);
      if (record.contentType === '视频') {
        record.videoPath = this.findVideoPath(attachmentPaths);
        record.imagePaths = [];
        if (!record.videoPath) {
          throw new Error('视频内容未找到可发布的视频素材');
        }
      } else {
        record.imagePaths = attachmentPaths;
      }

      if (record.contentType === '视频' && record.videoCover.length > 0) {
        this.setProgress({
          active: true,
          stage: 'downloading-cover',
          title: record.title,
          recordId: record.recordId,
          detail: `正在下载《${record.title}》的视频封面`,
        });
        // 物理隔离：cover 走独立子目录，避免封面文件名与主附件同名时互相覆盖。
        // 历史教训（2026-04-09 Codex 审计）：原本 cover 和 attachments 共用 tmpDir，
        // 一旦封面叫 "封面.png" 而主附件里也有同名图，后下载的会覆盖先下载的，
        // 上传时 videoPath / imagePaths 会指向被污染过的文件。
        const coverDir = path.join(tmpDir, 'cover');
        if (!fs.existsSync(coverDir)) fs.mkdirSync(coverDir, { recursive: true });
        const coverPaths = await this.feishu.downloadAllAttachments(record.videoCover, coverDir);
        record.coverPath = coverPaths[0];
      }

      const publishConfig = {
        yixiaoer: this.config.yixiaoer,
        bitbrowser: this.config.bitbrowser || {},
        defaultMusic: this.config.defaultMusic || null,
        rules: this.config.rules || {},
        yixiaoerAccountCache: this.config.yixiaoerAccountCache || {},
      };
      this.setProgress({
        active: true,
        stage: 'publishing',
        title: record.title,
        recordId: record.recordId,
        detail: `正在按已配置渠道提交《${record.title}》`,
      });
      const results = await publisher.publishRecord(record, publishConfig, this.config.accountMapping, {
        onProgress: (progress) => this.setProgress({ active: true, ...progress }),
      });

      let allSuccess = true;
      let hasSubmitted = false;
      let noteChanged = false;
      let nextNote = record.note || '';

      const contentHash = publisher.computeContentHash(record);

      for (const r of results) {
        if (r.success) {
          // 注意：r.success === true 包含一个特殊分支 r.c1Suspect === true。
          // 那是 publisher.js 在"发布 POST 网络异常 + 二次 /taskSets 查询也失败"
          // 的双重失败下做出的决策：宁可漏发也不双发，强制按"已发布"落盘。
          // 这里**故意**不为 c1Suspect 走单独分支，因为当前设计就是要让它
          // 走完整的成功路径（写飞书已发布 + 落本地账本），下轮调度不再重试。
          // 详细决策记录见 publisher.js 中 echoLookup.lookupError 处的长注释。
          // 已知漏发风险已记入 CLAUDE.md 待办，暂不修复，保稳定性为主。
          const finalized = r.finalized !== false;
          if (finalized) {
            // R6 修复：先飞书后本地。飞书写失败 → 本地账本不写，下次循环由 C1/血统账本兜底。
            try {
              await this.feishu.markPlatformStatus(record.recordId, r.platform, '已发布');
            } catch (markErr) {
              allSuccess = false;
              const entry = `${r.platform}状态回写失败(${r.account}): ${markErr.message}`;
              nextNote = this.mergeNoteEntry(nextNote, entry);
              noteChanged = true;
              this.log('error', `  ❌ ${r.platform}(${r.account}) 状态回写失败 → 本地账本不会标记，下次循环将由 C1/血统账本兜底`);
              continue;
            }
            // 飞书已成功 → 写本地账本 + 追加血统记录（顺序：history 先，ledger 后）
            try {
              if (!r.skipped && !r.c1Skipped) {
                publisher.appendHistory(record.recordId, r.platform, {
                  accountName: r.account,
                  accountId: r.accountId,
                  channel: r.publishMode || '蚁小二',
                  at: Date.now(),
                  taskId: r.taskMeta?.taskId || null,
                  contentHash,
                });
              }
              publisher.markAsPublished(record.recordId, r.platform);
            } catch (writeErr) {
              allSuccess = false;
              const critEntry = `🚨 CRITICAL: 飞书已写"已发布"但本地账本写入失败: ${writeErr.message}`;
              nextNote = this.mergeNoteEntry(nextNote, critEntry);
              noteChanged = true;
              this.log('error', `  ${critEntry}`);
            }
            const successEntry = r.skipped
              ? `${r.platform}已跳过(${r.c1Skipped ? 'C1预查重命中' : '之前已发布'})(${r.account})`
              : `${r.platform}发布成功(${r.account})`;
            nextNote = this.mergeNoteEntry(nextNote, successEntry);
            const latestRecord = await this.findLatestPublishRecord(r, record.title);
            const publishRecordEntry = this.formatPublishRecordEntry(latestRecord, r.platform);
            nextNote = this.mergeNoteEntry(nextNote, publishRecordEntry);
            if (r.musicMeta?.fallbackUsed) {
              this.log('info', `  🎵 ${r.platform}(${r.account}) ${r.musicMeta.message}`);
            }
            if (r.titleMeta?.truncated) {
              this.log('info', `  ✂️ ${r.platform}(${r.account}) 标题超限，已自动截断为 ${r.titleMeta.limit} 字`);
            }
            this.log('success', `  ✅ ${r.platform}(${r.account}) ${r.skipped ? '已跳过(之前已发布)' : '发布成功'}`);
          } else {
            allSuccess = false;
            hasSubmitted = true;
            await this.feishu.markPlatformStatus(record.recordId, r.platform, '发布中');
            const submittedEntry = `${r.platform}已提交(${r.account})`;
            nextNote = this.mergeNoteEntry(nextNote, submittedEntry);
            this.log('info', `  ⏳ ${r.platform}(${r.account}) 已提交到蚁小二，等待平台完成`);
          }

          if (r.titleMeta?.truncated) {
            nextNote = this.mergeNoteEntry(nextNote, `${r.platform}标题已自动截断为${r.titleMeta.limit}字`);
          }
          if (r.musicMeta?.message) {
            nextNote = this.mergeNoteEntry(nextNote, `${r.platform}配乐: ${r.musicMeta.message}`);
          }
          const taskEntry = this.formatTaskEntry(r);
          nextNote = this.mergeNoteEntry(nextNote, taskEntry);
          noteChanged = noteChanged || nextNote !== (record.note || '');
        } else if (r.crossAccount) {
          // P0 跨账号硬锁：写"已发布(跨账号已拒绝)"避免下一轮再试
          allSuccess = false;
          try {
            await this.feishu.markPlatformStatus(record.recordId, r.platform, '已发布(跨账号已拒绝)');
          } catch (markErr) {
            this.log('error', `  ❌ 写入跨账号拒绝状态失败: ${markErr.message}`);
          }
          const entry = `🚨 红线保护: ${r.platform}历史账号=[${(r.historyAccounts || []).join(',')}], 当前账号=[${r.account}], 已拒绝本次发布`;
          nextNote = this.mergeNoteEntry(nextNote, entry);
          noteChanged = true;
          this.log('error', `  🚨 ${entry}`);
        } else if (r.retryable) {
          // P0.4 C1 fail-closed → 飞书状态保持"待发布"，下轮自动重试，不污染状态
          allSuccess = false;
          const retryEntry = `${r.platform}本轮暂缓(${r.account}): ${r.error}`;
          nextNote = this.mergeNoteEntry(nextNote, retryEntry);
          noteChanged = true;
          this.log('warn', `  ⏳ ${r.platform}(${r.account}) 本轮暂缓，下轮重试: ${r.error}`);
        } else {
          allSuccess = false;
          await this.feishu.markPlatformStatus(record.recordId, r.platform, '发布失败');
          const failEntry = `${r.platform}发布失败(${r.account}): ${r.error}`;
          nextNote = this.mergeNoteEntry(nextNote, failEntry);
          noteChanged = true;
          this.log('error', `  ❌ ${r.platform}(${r.account}) 发布失败: ${r.error}`);
        }
      }

      if (noteChanged) {
        await this.feishu.setNote(record.recordId, nextNote);
        record.note = nextNote;
      }

      const allPendingCovered = pendingPlatforms.every(p =>
        results.some(r => r.platform === p && r.success)
      );
      if (allSuccess && results.length > 0 && allPendingCovered) {
        await this.feishu.markPublished(record.recordId);
        this.markRecordRecentlyPublished(record.recordId);
        this.setProgress({
          active: true,
          stage: 'completed',
          title: record.title,
          recordId: record.recordId,
          detail: `《${record.title}》已完成全部平台发布`,
        });
        this.log('success', `  ✅ "${record.title}" 全部发布成功`);
        return { published: 1, failed: 0 };
      }

      if (hasSubmitted && !results.some(item => !item.success)) {
        this.setProgress({
          active: true,
          stage: 'submitted',
          title: record.title,
          recordId: record.recordId,
          detail: `《${record.title}》已提交到蚁小二，等待平台完成`,
        });
        return { published: 0, failed: 0, submitted: 1 };
      }

      this.setProgress({
        active: true,
        stage: 'partial-failed',
        title: record.title,
        recordId: record.recordId,
        detail: `《${record.title}》发布完成，但存在失败平台`,
      });
      return { published: 0, failed: 1, ...(hasSubmitted ? { submitted: 1 } : {}) };
    } catch (e) {
      this.setProgress({
        active: true,
        stage: 'failed',
        title: record.title,
        recordId: record.recordId,
        detail: `《${record.title}》处理失败: ${e.message}`,
      });
      this.log('error', `  ❌ "${record.title}" 处理失败: ${e.message}`);
      const nextNote = this.mergeNoteEntry(record.note, `处理失败: ${e.message}`);
      await this.feishu.setNote(record.recordId, nextNote);
      return { published: 0, failed: 1 };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  async reconcileCloudPublishing() {
    const platforms = ['小红书', '抖音'];
    for (const platform of platforms) {
      let pendingRecords;
      try {
        pendingRecords = await this.feishu.getRecordsByPlatformStatus(platform, '发布中');
      } catch (e) {
        this.log('warn', `⚠️ 查询${platform}发布中记录失败: ${e.message}`);
        continue;
      }

      if (!pendingRecords.length) continue;
      this.log('info', `🔄 发现 ${pendingRecords.length} 条${platform}处于"发布中"，开始补查蚁小二状态...`);

      for (const rawRecord of pendingRecords) {
        let parsed;
        try {
          parsed = this.feishu.parseRecord(rawRecord);
        } catch (e) {
          this.log('warn', `  ⚠️ 解析记录失败(${rawRecord.record_id}): ${e.message}`);
          continue;
        }

        const taskIdMatch = (parsed.note || '').match(/任务ID:(\S+)/);
        const taskId = taskIdMatch?.[1] || null;
        if (!taskId) {
          this.log('warn', `  ⚠️ ${platform}(${parsed.recordId}) 备注中未找到任务ID，跳过轮询`);
          continue;
        }

        let taskStatus;
        try {
          taskStatus = await publisher.getTaskSetStatus(taskId);
        } catch (e) {
          this.log('warn', `  ⚠️ 查询任务状态失败(taskId=${taskId}): ${e.message}`);
          continue;
        }

        if (!taskStatus) {
          this.log('info', `  ⏳ ${platform}(${parsed.recordId}) 任务 ${taskId} 暂无结果，继续等待`);
          continue;
        }

        if (taskStatus === 'allsuccessful' || taskStatus === 'partialsuccessful') {
          this.log('info', `  ✅ ${platform}(${parsed.recordId}) 云发布成功(${taskStatus})，写飞书+落账本`);
          try {
            await this.feishu.markPlatformStatus(parsed.recordId, platform, '已发布');
          } catch (e) {
            this.log('error', `  ❌ 更新飞书状态失败: ${e.message}`);
            continue;
          }
          try {
            const accountName = platform === '小红书' ? parsed.xiaohongshuAccount : parsed.douyinAccount;
            const contentHash = publisher.computeContentHash(parsed);
            publisher.appendHistory(parsed.recordId, platform, {
              accountName,
              accountId: null,
              channel: '蚁小二(云发布)',
              at: Date.now(),
              taskId,
              contentHash,
            });
            publisher.markAsPublished(parsed.recordId, platform);
          } catch (e) {
            this.log('error', `  ❌ 写本地账本失败: ${e.message}`);
          }
        } else if (taskStatus === 'allfailed' || taskStatus === 'cancel') {
          this.log('info', `  ❌ ${platform}(${parsed.recordId}) 云发布失败(${taskStatus})，更新飞书`);
          try {
            await this.feishu.markPlatformStatus(parsed.recordId, platform, '发布失败');
          } catch (e) {
            this.log('error', `  ❌ 更新飞书失败状态失败: ${e.message}`);
          }
        } else {
          // pending / publishing → 继续等待
          this.log('info', `  ⏳ ${platform}(${parsed.recordId}) 任务状态: ${taskStatus}，继续等待`);
        }
      }
    }
  }

  async publishRecords(records, reason = 'auto', options = {}) {
    this.ensureFeishuConfigured();
    const queued = this.enqueuePublishRecords(records, options);

    if (this.publishing) {
      if (queued > 0) {
        this.log('info', `🗂 当前已有发布任务，已追加 ${queued} 条记录到队列`);
      }
      return { published: 0, failed: 0, queued, inProgress: true };
    }

    this.publishing = true;
    this.activePublishReason = reason;
    this.stopRequested = false;
    this.setProgress({
      active: true,
      stage: reason === 'manual' ? 'manual-checking' : 'checking',
      title: '',
      recordId: '',
      platform: '',
      account: '',
      detail: reason === 'manual' ? '正在处理手动发布记录' : '正在执行到点发布任务',
    });
    this.log('info', reason === 'manual' ? '🚀 开始执行手动发布...' : '🚀 开始执行到点发布任务...');

    try {
      if (this.pendingPublishRecords.size === 0) {
        this.setProgress({
          active: false,
          stage: 'idle',
          title: '',
          recordId: '',
          platform: '',
          account: '',
          detail: '当前没有需要发布的记录',
        });
        this.log('info', reason === 'manual' ? '📭 没有可手动发布的记录' : '📭 当前没有需要执行的定时任务');
        return { published: 0, failed: 0 };
      }

      let publishedCount = 0;
      let failedCount = 0;
      let submittedCount = 0;

      while (this.pendingPublishRecords.size > 0) {
        if (this.shouldAbortQueuedWork(reason)) {
          this.pendingPublishRecords.clear();
          this.log('info', '🛑 服务已停止，剩余排队任务不再继续处理');
          break;
        }

        const toPublish = this.takeQueuedPublishRecords().filter(record => this.recordHasPublishablePlatform(record));
        if (toPublish.length === 0) continue;

        this.log('info', `📋 找到 ${toPublish.length} 条待处理记录`);
        if (this.requiresYixiaoerLogin(toPublish)) {
          await publisher.ensureLogin(this.config.yixiaoer);
          await this.syncAccountMappingsForRecords(toPublish);
        }

        const batchResults = await mapWithConcurrency(
          toPublish,
          this.getPublishConcurrency(),
          async (record) => {
            if (this.shouldAbortQueuedWork(reason)) {
              return { published: 0, failed: 0 };
            }
            this.processingRecordIds.add(record.recordId);
            try {
              return await this.processSingleRecord(record, options);
            } finally {
              this.processingRecordIds.delete(record.recordId);
            }
          }
        );

        for (const item of batchResults) {
          publishedCount += item?.published || 0;
          failedCount += item?.failed || 0;
          submittedCount += item?.submitted || 0;
        }

        // 临时目录已在每条记录的 processSingleRecord finally 中各自清理；
        // 这里曾有一行 fs.rmSync(tmpDir, ...) 但 tmpDir 在该作用域未定义，
        // 一直抛 ReferenceError 然后被静默吞掉，是死代码，已删除。
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      this.setProgress({
        active: false,
        stage: 'idle',
        title: '',
        recordId: '',
        platform: '',
        account: '',
        detail: submittedCount > 0
          ? `本轮发布完成: 成功 ${publishedCount}, 提交中 ${submittedCount}, 失败 ${failedCount}`
          : `本轮发布完成: 成功 ${publishedCount}, 失败 ${failedCount}`,
      });
      this.log(
        'info',
        submittedCount > 0
          ? `📊 本轮完成: 成功 ${publishedCount}, 提交中 ${submittedCount}, 失败 ${failedCount}`
          : `📊 本轮完成: 成功 ${publishedCount}, 失败 ${failedCount}`
      );
      return {
        published: publishedCount,
        failed: failedCount,
        ...(submittedCount > 0 ? { submitted: submittedCount } : {}),
      };
    } catch (e) {
      this.setProgress({
        active: false,
        stage: 'failed',
        title: '',
        recordId: '',
        platform: '',
        account: '',
        detail: `检查失败: ${e.message}`,
      });
      this.log('error', `❌ 检查失败: ${e.message}`);
      return { published: 0, failed: 0, error: e.message };
    } finally {
      this.publishing = false;
      this.activePublishReason = null;
      this.stopRequested = false;
    }
  }

  async checkAndPublish() {
    this.ensureFeishuConfigured();
    if (!this.running) {
      return { scheduled: 0, skipped: true };
    }

    // 补查上轮云发布（finalized=false）的最终状态
    try {
      await this.reconcileCloudPublishing();
    } catch (e) {
      this.log('warn', `⚠️ 云发布状态补查失败: ${e.message}`);
    }

    this.setProgress({
      active: true,
      stage: 'scanning',
      title: '',
      recordId: '',
      platform: '',
      account: '',
      detail: '正在扫描飞书定时发布记录',
    });
    this.log('info', '🔍 开始扫描飞书表格，补建精准发布时间任务...');

    try {
      const hasPendingRecords = await this.feishu.hasPendingRecords();
      if (!hasPendingRecords) {
        this.log('info', '🈳 本轮未发现待发布记录，跳过完整扫描');
        this.setProgress({
          active: false,
          stage: 'idle',
          title: '',
          recordId: '',
          platform: '',
          account: '',
          detail: '当前没有待发布记录',
        });
        return { scheduled: 0, published: 0, failed: 0, skippedEmptyProbe: true };
      }

      const records = await this.feishu.getUnpublishedRecords();
      const parsed = records.map(r => this.feishu.parseRecord(r));

      if (this.config.aiWriting?.enabled) {
        try {
          await this.runAiWriting(parsed);
        } catch (e) {
          // AI 写作异常不中断发布流程
          this.log('warn', `⚠️ AI 写作扫描异常，跳过本轮生成：${e.message}`);
        }
      } else if (this.config.aiWriting?.apiKey) {
        this.log('info', 'ℹ️ AI 写作已配置但未启用，如需开启请到设置页勾选「启用 AI 写作」并保存');
      }

      const now = new Date();
      let scheduledCount = 0;
      let dueNow = [];

      for (const record of parsed) {
        if (!this.recordHasPendingPlatform(record)) continue;
        if (!this.recordHasContent(record)) {
          this.log('warn', `⚠️ 跳过《${record.title || record.recordId}》：标题或素材为空`);
          continue;
        }
        if (!record.publishTime) continue;

        const publishTime = new Date(record.publishTime);
        const taskKey = this.getScheduledTaskKey(record.recordId, publishTime);
        if (this.scheduledTasks.has(taskKey)) continue;

        if (publishTime <= now) {
          dueNow.push(record);
          continue;
        }

        this.scheduleRecordTask(record, publishTime);
        scheduledCount++;
      }

      this.log('info', `🗓 本轮扫描新增 ${scheduledCount} 个精准发布任务`);

      if (dueNow.length > 0) {
        this.log('info', `⏰ 发现 ${dueNow.length} 条已到发布时间但未建任务的记录，立即补发`);
        await this.publishRecords(dueNow, 'scheduled');
      } else {
        this.setProgress({
          active: false,
          stage: 'idle',
          title: '',
          recordId: '',
          platform: '',
          account: '',
          detail: scheduledCount > 0 ? `已新增 ${scheduledCount} 个精准任务` : '当前无需补建新的发布时间任务',
        });
      }

      return { scheduled: scheduledCount, published: dueNow.length, failed: 0 };
    } catch (e) {
      this.setProgress({
        active: false,
        stage: 'failed',
        title: '',
        recordId: '',
        platform: '',
        account: '',
        detail: `扫描失败: ${e.message}`,
      });
      this.log('error', `❌ 扫描失败: ${e.message}`);
      return { scheduled: 0, failed: 0, error: e.message };
    }
  }

  scheduleRecordTask(record, publishTime) {
    const taskKey = this.getScheduledTaskKey(record.recordId, publishTime);
    const delay = Math.max(0, publishTime.getTime() - Date.now());
    const timer = setTimeout(() => {
      (async () => {
        this.scheduledTasks.delete(taskKey);
        if (!this.running) return;

        const latestRecord = await this.loadCurrentPendingRecord(record.recordId);
        if (!latestRecord) {
          this.log('info', `🧹 精准任务已跳过：记录 ${record.recordId} 已不在待发布列表`);
          return;
        }
        if (!this.recordHasPendingPlatform(latestRecord)) {
          this.log('info', `🧹 精准任务已跳过：记录《${latestRecord.title}》平台状态已非待发布`);
          return;
        }
        if (!latestRecord.publishTime) {
          this.log('info', `🧹 精准任务已跳过：记录《${latestRecord.title}》已移除发布时间`);
          return;
        }

        const latestPublishTime = new Date(latestRecord.publishTime);
        if (latestPublishTime.getTime() !== publishTime.getTime()) {
          this.log('info', `🔁 记录《${latestRecord.title}》发布时间已变更，重建精准任务`);
          this.scheduleRecordTask(latestRecord, latestPublishTime);
          return;
        }

        await this.publishRecords([latestRecord], 'scheduled');
      })().catch(e => {
        this.log('error', `❌ 精准任务执行失败：${record.title} - ${e.message}`);
      });
    }, delay);

    this.scheduledTasks.set(taskKey, {
      recordId: record.recordId,
      title: record.title,
      publishTime: publishTime.getTime(),
      timer,
    });
    this.log('info', `🗓 已创建精准任务：${record.title} -> ${publishTime.toLocaleString('zh-CN')}`);
  }

  getScheduledTasks() {
    const now = Date.now();
    return Array.from(this.scheduledTasks.values())
      .map(task => ({
        recordId: task.recordId,
        title: task.title,
        publishTime: task.publishTime,
        remainingMs: task.publishTime - now,
      }))
      .sort((a, b) => a.publishTime - b.publishTime);
  }

  async manualPublishNow() {
    this.ensureFeishuConfigured();
    const records = await this.feishu.getUnpublishedRecords();
    const parsed = records.map(r => this.feishu.parseRecord(r));
    const now = new Date();
    const toPublish = parsed.filter(record => {
      if (!this.recordHasPendingPlatform(record)) return false;
      if (!record.publishTime) return true;
      return new Date(record.publishTime) <= now;
    });
    return this.publishRecords(toPublish, 'manual');
  }

  async publishSpecificRecord(recordId) {
    this.ensureFeishuConfigured();
    const records = await this.feishu.getUnpublishedRecords();
    const parsed = records.map(r => this.feishu.parseRecord(r));
    const target = parsed.find(r => r.recordId === recordId);
    if (!target) throw new Error('找不到该记录或已发布');
    if (!this.recordHasPendingPlatform(target)) throw new Error('该记录没有待发布的平台');
    for (const [key, task] of this.scheduledTasks.entries()) {
      if (task.recordId === recordId) {
        clearTimeout(task.timer);
        this.scheduledTasks.delete(key);
        this.log('info', `已取消「${target.title}」的定时任务，改为立即发布`);
      }
    }
    return this.publishRecords([target], 'manual', { allowRecentPublished: true });
  }

  start() {
    if (this.config.isMasterPublisher === false) {
      this.log('info', '非发布主机模式，调度器不启动');
      return;
    }
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.log('info', '🚀 定时发布服务已启动');
    Promise.resolve()
      .then(() => this.checkAndPublish())
      .catch((error) => {
        this.log('error', `❌ 启动后首次扫描失败: ${error.message}`);
      });
    this.scheduleNext();
  }

  scheduleNext() {
    if (!this.running) return;
    const nextTime = this.getNextCheckTime();
    const delay = nextTime.getTime() - Date.now();
    this.log('info', `⏰ 下次检查: ${nextTime.toLocaleString('zh-CN')} (${Math.round(delay / 60000)} 分钟后)`);
    this.scanTimer = setTimeout(async () => {
      await this.checkAndPublish();
      this.scheduleNext();
    }, delay);
  }

  stop() {
    this.running = false;
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    this.clearScheduledTasks();
    if (this.publishing && this.activePublishReason !== 'manual') {
      this.stopRequested = true;
      this.pendingPublishRecords.clear();
      this.setProgress({
        active: true,
        stage: 'stopping',
        title: '',
        recordId: '',
        platform: '',
        account: '',
        detail: '已停止接收新任务，等待当前执行中的记录收尾',
      });
      this.log('info', '⏹ 已停止接收新的定时任务，当前执行中的记录会收尾后结束');
      return { draining: true };
    }
    this.log('info', '⏹ 定时发布服务已停止');
    return { draining: false };
  }

  updateSchedule(schedule) {
    this.config.schedule = schedule;
    const desc = schedule.periods.map(p => `${p.startTime}-${p.endTime}(${p.intervalMinutes}分钟)`).join(', ');
    this.log('info', `⚙️ 定时配置已更新: ${desc}`);
    if (this.running) {
      if (this.scanTimer) clearTimeout(this.scanTimer);
      this.scanTimer = null;
      this.scheduleNext();
    }
  }

  getStatus() {
    return {
      running: this.running,
      nextCheck: this.running ? this.getNextCheckTime().toLocaleString('zh-CN') : null,
      scheduledCount: this.scheduledTasks.size,
      schedule: this.config.schedule,
      recentLogs: this.logs.slice(-50),
      currentProgress: this.currentProgress,
    };
  }
}

module.exports = Scheduler;
