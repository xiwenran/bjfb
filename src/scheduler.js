const fs = require('fs');
const FeishuClient = require('./feishu.js');
const publisher = require('./publisher.js');
const { mapWithConcurrency } = require('./async-utils.js');
const {
  updateYixiaoerAccountCache,
  buildDesiredAccountNamesFromRecords,
  autoMapAccountMappings,
} = require('./account-mapping.js');
const { getRecordTempDir, isFeishuConfigured, saveConfig } = require('./config-store.js');
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
    this.pendingPublishRecords = new Map();
    this.processingRecordIds = new Set();
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

  enqueuePublishRecords(records = []) {
    let queued = 0;
    for (const record of records) {
      if (!record || !record.recordId) continue;
      if (!this.recordHasPendingPlatform(record)) continue;
      if (this.processingRecordIds.has(record.recordId)) continue;
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

  async processSingleRecord(record) {
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
        const coverPaths = await this.feishu.downloadAllAttachments(record.videoCover, tmpDir);
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
      let noteChanged = false;
      let nextNote = record.note || '';

      for (const r of results) {
        if (r.success) {
          await this.feishu.markPlatformStatus(record.recordId, r.platform, '已发布');
          const successEntry = `${r.platform}发布成功(${r.account})`;
          nextNote = this.mergeNoteEntry(nextNote, successEntry);
          if (r.titleMeta?.truncated) {
            nextNote = this.mergeNoteEntry(nextNote, `${r.platform}标题已自动截断为${r.titleMeta.limit}字`);
          }
          if (r.musicMeta?.message) {
            nextNote = this.mergeNoteEntry(nextNote, `${r.platform}配乐: ${r.musicMeta.message}`);
          }
          const taskEntry = this.formatTaskEntry(r);
          nextNote = this.mergeNoteEntry(nextNote, taskEntry);
          const latestRecord = await this.findLatestPublishRecord(r, record.title);
          const publishRecordEntry = this.formatPublishRecordEntry(latestRecord, r.platform);
          nextNote = this.mergeNoteEntry(nextNote, publishRecordEntry);
          noteChanged = noteChanged || nextNote !== (record.note || '');
          if (r.musicMeta?.fallbackUsed) {
            this.log('info', `  🎵 ${r.platform}(${r.account}) ${r.musicMeta.message}`);
          }
          if (r.titleMeta?.truncated) {
            this.log('info', `  ✂️ ${r.platform}(${r.account}) 标题超限，已自动截断为 ${r.titleMeta.limit} 字`);
          }
          this.log('success', `  ✅ ${r.platform}(${r.account}) ${r.skipped ? '已跳过(之前已发布)' : '发布成功'}`);
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

      if (allSuccess && results.length > 0) {
        await this.feishu.markPublished(record.recordId);
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

      this.setProgress({
        active: true,
        stage: 'partial-failed',
        title: record.title,
        recordId: record.recordId,
        detail: `《${record.title}》发布完成，但存在失败平台`,
      });
      return { published: 0, failed: 1 };
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

  async publishRecords(records, reason = 'auto') {
    this.ensureFeishuConfigured();
    const queued = this.enqueuePublishRecords(records);

    if (this.publishing) {
      if (queued > 0) {
        this.log('info', `🗂 当前已有发布任务，已追加 ${queued} 条记录到队列`);
      }
      return { published: 0, failed: 0, queued, inProgress: true };
    }

    this.publishing = true;
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

      while (this.pendingPublishRecords.size > 0) {
        const toPublish = this.takeQueuedPublishRecords().filter(record => this.recordHasPendingPlatform(record));
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
            this.processingRecordIds.add(record.recordId);
            try {
              return await this.processSingleRecord(record);
            } finally {
              this.processingRecordIds.delete(record.recordId);
            }
          }
        );

        for (const item of batchResults) {
          publishedCount += item?.published || 0;
          failedCount += item?.failed || 0;
        }
      }

      this.setProgress({
        active: false,
        stage: 'idle',
        title: '',
        recordId: '',
        platform: '',
        account: '',
        detail: `本轮发布完成: 成功 ${publishedCount}, 失败 ${failedCount}`,
      });
      this.log('info', `📊 本轮完成: 成功 ${publishedCount}, 失败 ${failedCount}`);
      return { published: publishedCount, failed: failedCount };
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
    }
  }

  async checkAndPublish() {
    this.ensureFeishuConfigured();
    if (!this.running) {
      return { scheduled: 0, skipped: true };
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
      const records = await this.feishu.getUnpublishedRecords();
      const parsed = records.map(r => this.feishu.parseRecord(r));
      const now = new Date();
      let scheduledCount = 0;
      let dueNow = [];

      for (const record of parsed) {
        if (!this.recordHasPendingPlatform(record)) continue;
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
    return this.publishRecords([target], 'manual');
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.log('info', '🚀 定时发布服务已启动');
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
    this.log('info', '⏹ 定时发布服务已停止');
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
