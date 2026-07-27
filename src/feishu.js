const axios = require('axios').create({ timeout: 30000 });
const fs = require('fs');
const path = require('path');
const { mapWithConcurrency } = require('./async-utils.js');
const { readImportRecovery, saveImportRecovery } = require('./config-store.js');

// 缓存 24 小时(超过认为飞书 fileToken 可能失效,重新上传更安全)
// TODO(B4 冷眼审查 P0-5): 24h 没查证,审查员建议保守降到 1h
const RECOVERY_TTL_MS = 24 * 3600 * 1000;

// scope: 双表模式下用目标表 appToken 区分同一张图在不同平台表下的 fileToken 缓存,
// 避免小红书表上传得到的 fileToken 被抖音表复用(fileToken 归属特定 app,跨 app 不可用,
// 飞书写入时报错 code=1254303 "The attachment does not belong to this bitable")。
// 未传 scope 时(旧版单表模式)行为与之前一致。
function makeRecoveryKey(imagePath, scope = '') {
  try {
    const stat = fs.statSync(imagePath);
    return `${scope}|${imagePath}|${stat.size}|${Math.floor(stat.mtimeMs)}`;
  } catch (_) {
    // 文件不存在 fallback 用纯路径(后续上传会失败,这里只是为了不崩)
    return `${scope}|${imagePath}`;
  }
}

// recovery 内存缓存:同一进程多次上传时不必反复读盘
// TODO(B4 冷眼审查 P0-2): 单例 + JSON.stringify 期间被并发 mutate 风险,需要浅拷贝再序列化
let _recoveryCache = null;
function getRecovery() {
  if (_recoveryCache === null) _recoveryCache = readImportRecovery();
  return _recoveryCache;
}
function persistRecovery() {
  if (_recoveryCache !== null) saveImportRecovery(_recoveryCache);
}
// 给单元测试 / 异常清理用,正常流程不需要
function _resetRecoveryCache() { _recoveryCache = null; }

function parseAttachmentSortKey(name) {
  const normalizedName = String(name || '')
    .trim()
    .replace(/（/g, '(')
    .replace(/）/g, ')');

  // 仅当**整个文件名**是「纯数字编号 [+ 子序号] [+ 扩展名]」时才参与排序。
  // Codex 对抗性审查（2026-04-22）：原正则只锚开头不锚结尾，会把
  // "20260422-cover.png" / "1 封面.png" / "12abc.png" 误判为编号页排到最前。
  // 现强制 ^...$ 整体匹配，非纯编号文件保留飞书原顺序。
  // 支持：
  //   "1.png" / "10" → [10, -1]
  //   小数点子序号："1.2.png" → [1, 2]；"0.1.png" → [0, 1]
  //   括号子序号（macOS 重名）："1(2).png" / "0 (4).png" / "0（4）.png" → [主序号, 子序号]
  const m = normalizedName.match(/^(\d+)(?:\.(\d+)|\s*\((\d+)\))?(?:\.[^.]+)?$/);
  if (!m) return null;
  const main = Number(m[1]);
  const sub = m[2] != null ? Number(m[2]) : (m[3] != null ? Number(m[3]) : -1);
  return [main, sub];
}

function orderAttachmentsForDownload(attachments = []) {
  return [...attachments]
    .map((att, index) => ({ att, index }))
    .sort((left, right) => {
      const leftName = path.basename(String(left.att.name || ''));
      const rightName = path.basename(String(right.att.name || ''));
      const leftKey = parseAttachmentSortKey(leftName);
      const rightKey = parseAttachmentSortKey(rightName);

      if (leftKey && rightKey) {
        const cmp = leftKey[0] - rightKey[0];
        if (cmp !== 0) return cmp;
        return leftKey[1] - rightKey[1] || left.index - right.index;
      }
      if (leftKey) return -1;
      if (rightKey) return 1;
      return left.index - right.index;
    })
    .map(item => item.att);
}

// ── 双表路由（2026-07 新增）──────────────────────────────────────────────
// 背景：小红书与抖音发布分流到两张独立多维表格。未配置 config.feishu.tables 时，
// 两平台仍共用旧版单 appToken+tableId，行为零变化。
const PLATFORM_ALIASES = {
  '小红书': 'xiaohongshu',
  'xiaohongshu': 'xiaohongshu',
  '抖音': 'douyin',
  'douyin': 'douyin',
};
const PLATFORM_LABEL = { xiaohongshu: '小红书', douyin: '抖音' };

function normalizePlatformKey(platform) {
  if (!platform) return null;
  return PLATFORM_ALIASES[platform] || null;
}

// 两表真实字段清单（2026-07-26 lark-cli 实拉）：
// 公共字段两表都有；平台专属字段只属于对应表；每张表上还各残留一个属于对方平台的
// 字段（小红书表残留"抖音发布人"、抖音表残留"小红书发布状态"），这两个残留字段
// 永远不写。
const COMMON_FEISHU_FIELDS = [
  '备注', '内容类型', '素材', '视频封面', '标题', '发布时间',
  '正文', '标题字数', '笔记主题', '导入指纹', '记录时间', '标签',
];
const PLATFORM_ONLY_FEISHU_FIELDS = {
  xiaohongshu: ['小红书发布渠道', '小红书账号', '小红书发布状态'],
  douyin: ['抖音发布状态', '抖音发布人', '抖音账号'],
};

// 按平台字段白名单过滤待写入字段。platformKey 为 null 时（未路由到具体某张双表，
// 即旧版单表模式）原样透传，不做任何过滤——保证未配置 tables 时行为零变化。
function filterFieldsForPlatform(fields, platformKey) {
  if (!platformKey) return { fields: { ...(fields || {}) }, dropped: [] };
  const whitelist = new Set([
    ...COMMON_FEISHU_FIELDS,
    ...(PLATFORM_ONLY_FEISHU_FIELDS[platformKey] || []),
  ]);
  const out = {};
  const dropped = [];
  for (const [name, value] of Object.entries(fields || {})) {
    if (whitelist.has(name)) out[name] = value;
    else dropped.push(name);
  }
  return { fields: out, dropped };
}

class FeishuClient {
  constructor(config = {}) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    // 旧版单表（legacy）：未配置 tables 或某平台未在 tables 中配置时的回退目标。
    this.appToken = config.appToken;
    this.tableId = config.tableId;
    // 双表配置：{ xiaohongshu: {appToken,tableId}, douyin: {appToken,tableId} }
    this.tables = (config.tables && typeof config.tables === 'object') ? config.tables : null;
    this.accessToken = null;
    this.tokenExpiry = 0;
  }

  // 解析某个平台应该访问哪张表。
  // 返回 platformKey !== null 时表示"确实路由到了双表模式下的某张表"，
  // 调用方据此决定是否要应用字段白名单过滤；platformKey === null 表示走的是
  // 旧版单表回退路径，不过滤，保证零行为变化。
  _resolveTable(platform) {
    const key = normalizePlatformKey(platform);
    const table = key && this.tables ? this.tables[key] : null;
    if (table && table.appToken && table.tableId) {
      return { appToken: table.appToken, tableId: table.tableId, platformKey: key };
    }
    return { appToken: this.appToken, tableId: this.tableId, platformKey: null };
  }

  // 双表模式下已经完整配置好的平台键列表；旧版单表模式返回空数组
  // （调用方应改用单表原逻辑，不走逐平台循环）。
  _configuredDualPlatforms() {
    if (!this.tables) return [];
    return ['xiaohongshu', 'douyin'].filter(key => {
      const t = this.tables[key];
      return t && t.appToken && t.tableId;
    });
  }

  async getAccessToken(forceRefresh = false) {
    if (!forceRefresh && this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }
    const resp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: this.appId,
      app_secret: this.appSecret,
    });
    this.accessToken = resp.data.tenant_access_token;
    this.tokenExpiry = Date.now() + (resp.data.expire - 60) * 1000;
    return this.accessToken;
  }

  // 自动重试机制:
  // - 401 → token 失效,force refresh 后重试一次
  // - 408/429/502/503/504 → 限流/网关问题,2 秒后重试一次(不刷 token)
  // - ECONNRESET/ETIMEDOUT/ECONNABORTED → 网络抖动,2 秒后重试一次
  // 其他错误直接抛给调用方
  async requestWithRetry(fn) {
    try {
      return await fn(await this.getAccessToken());
    } catch (e) {
      const status = e.response?.status;
      const code = e.code;
      // 1) Token 失效 → 强制刷新后重试
      if (status === 401) {
        return await fn(await this.getAccessToken(true));
      }
      // 2) 限流/网关/网络抖动 → 等 2 秒,带原 token 重试 1 次
      const isTransient =
        status === 408 || status === 429 ||
        status === 502 || status === 503 || status === 504 ||
        code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED';
      if (isTransient) {
        await new Promise(r => setTimeout(r, 2000));
        return await fn(await this.getAccessToken());
      }
      // 3) 其他 HTTP 错误 → 把飞书返回的响应体附到错误信息里，方便排查
      if (e.response?.data && status) {
        const body = typeof e.response.data === 'object'
          ? JSON.stringify(e.response.data)
          : String(e.response.data).slice(0, 300);
        const enriched = new Error(`HTTP ${status}: ${body}`);
        enriched.feishuCode = e.response.data?.code;
        enriched.response = e.response;
        throw enriched;
      }
      throw e;
    }
  }

  async getRecords(filter, platform) {
    const { appToken, tableId } = this._resolveTable(platform);
    const items = [];
    let pageToken;
    let hasMore = true;

    while (hasMore) {
      const body = { page_size: 100, automatic_fields: true };
      if (filter) body.filter = filter;
      if (pageToken) body.page_token = pageToken;

      const resp = await this.requestWithRetry(token =>
        axios.post(
          `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/search`,
          body,
          { headers: { Authorization: `Bearer ${token}` } }
        )
      );

      const data = resp.data.data || {};
      items.push(...(data.items || []));
      hasMore = Boolean(data.has_more);
      pageToken = data.page_token;
    }

    return items;
  }

  async _hasPendingWithFilter(filter, platform) {
    const { appToken, tableId } = this._resolveTable(platform);
    const resp = await this.requestWithRetry(token =>
      axios.post(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/search`,
        { page_size: 1, automatic_fields: false, filter },
        { headers: { Authorization: `Bearer ${token}` } }
      )
    );
    const items = resp.data?.data?.items || [];
    return items.length > 0;
  }

  async hasPendingRecords() {
    const dualPlatforms = this._configuredDualPlatforms();
    if (dualPlatforms.length === 0) {
      // 旧版单表：一张表内 OR 两个平台状态字段，与改造前完全一致。
      const filter = {
        conjunction: 'or',
        conditions: [
          { field_name: '小红书发布状态', operator: 'is', value: ['待发布'] },
          { field_name: '抖音发布状态', operator: 'is', value: ['待发布'] },
        ],
      };
      return await this._hasPendingWithFilter(filter, null);
    }

    // 双表：小红书表查"小红书发布状态"，抖音表查"抖音发布状态"，任一命中即返回。
    const FIELD_BY_PLATFORM = { xiaohongshu: '小红书发布状态', douyin: '抖音发布状态' };
    for (const platformKey of dualPlatforms) {
      const filter = {
        conjunction: 'and',
        conditions: [{ field_name: FIELD_BY_PLATFORM[platformKey], operator: 'is', value: ['待发布'] }],
      };
      if (await this._hasPendingWithFilter(filter, platformKey)) return true;
    }
    return false;
  }

  // 根据 recordId 拉取单条最新记录。供 scheduler 在发布前做"二次校验账号字段"使用。
  // platform 未传时按旧版单表解析；传入后按该平台对应的表解析。
  async getRecordById(recordId, platform) {
    if (!recordId) return null;
    const { appToken, tableId } = this._resolveTable(platform);
    const token = await this.getAccessToken();
    const resp = await axios.get(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return resp.data?.data?.record || null;
  }

  // 启动期校验关键字段必须是 type=3 (单选)。
  // 任何一个字段不是单选 → 抛错；调用方负责让进程退出。
  async assertSingleSelectFields(fieldNames, platform) {
    const fields = await this.getFields(platform);
    const errors = [];
    for (const name of fieldNames) {
      const field = fields.find(item => item.field_name === name);
      if (!field) {
        errors.push(`字段不存在: ${name}`);
        continue;
      }
      if (field.type !== 3) {
        errors.push(`字段 ${name} 不是单选 (type=${field.type})`);
      }
    }
    if (errors.length > 0) {
      throw new Error(`飞书字段类型校验失败:\n  - ${errors.join('\n  - ')}`);
    }
    return true;
  }

  async getFields(platform) {
    const { appToken, tableId } = this._resolveTable(platform);
    const items = [];
    let pageToken;
    let hasMore = true;

    while (hasMore) {
      const resp = await this.requestWithRetry(token =>
        axios.get(
          `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
          {
            headers: { Authorization: `Bearer ${token}` },
            params: { page_size: 100, page_token: pageToken },
          }
        )
      );
      const data = resp.data.data || {};
      items.push(...(data.items || []));
      hasMore = Boolean(data.has_more);
      pageToken = data.page_token;
    }

    return items;
  }

  async updateField(fieldId, body, platform) {
    const { appToken, tableId } = this._resolveTable(platform);
    const resp = await this.requestWithRetry(token =>
      axios.put(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${fieldId}`,
        body,
        { headers: { Authorization: `Bearer ${token}` } }
      )
    );
    return resp.data.data?.field || null;
  }

  buildSingleSelectOptions(existingOptions = [], targetNames = [], options = {}) {
    const nextNames = (targetNames || [])
      .map(name => String(name || '').trim())
      .filter(Boolean);

    const existingNames = options.keepExisting
      ? (existingOptions || []).map(option => String(option.name || '').trim()).filter(Boolean)
      : [];

    const cleanNames = [...new Set([...existingNames, ...nextNames])];

    const existingByName = new Map(
      (existingOptions || []).map(option => [String(option.name || '').trim(), option]).filter(([name]) => name)
    );

    let nextColor = (existingOptions || []).reduce((max, option) => {
      return Math.max(max, Number.isInteger(option.color) ? option.color : -1);
    }, -1) + 1;

    return cleanNames.map(name => {
      const existing = existingByName.get(name);
      if (existing) {
        return {
          id: existing.id,
          name,
          color: Number.isInteger(existing.color) ? existing.color : 0,
        };
      }

      const option = { name, color: nextColor % 55 };
      nextColor += 1;
      return option;
    });
  }

  async syncSingleSelectFieldOptions(fieldName, targetNames = [], options = {}, platform) {
    const fields = await this.getFields(platform);
    const field = fields.find(item => item.field_name === fieldName);
    if (!field) {
      throw new Error(`未找到飞书字段: ${fieldName}`);
    }

    if (field.type !== 3) {
      throw new Error(`飞书字段 ${fieldName} 不是单选字段(type=${field.type})`);
    }

    const property = field.property || {};
    const nextOptions = this.buildSingleSelectOptions(property.options || [], targetNames, options);
    return await this.updateField(field.field_id, {
      field_name: field.field_name,
      type: field.type,
      property: {
        ...property,
        options: nextOptions,
      },
    }, platform);
  }

  async getSingleSelectFieldOptionNames(fieldName, platform) {
    const fields = await this.getFields(platform);
    const field = fields.find(item => item.field_name === fieldName);
    if (!field || field.type !== 3) return [];
    return (field.property?.options || [])
      .map(option => String(option.name || '').trim())
      .filter(Boolean);
  }

  // 双表模式下：分别查小红书表/抖音表各自平台的状态字段，合并结果；
  // 并在每条原始记录上打 __platform 标记（'xiaohongshu'|'douyin'），
  // 供 parseRecord() 透出为 platform 字段，下游据此路由后续写操作到正确的表。
  // 旧版单表模式：单次查询，不打标记，与改造前完全一致。
  async _scanBothPlatforms(buildConditions) {
    const dualPlatforms = this._configuredDualPlatforms();
    if (dualPlatforms.length === 0) {
      const PLATFORM_FIELDS = ['小红书发布状态', '抖音发布状态'];
      const conditions = PLATFORM_FIELDS.flatMap(buildConditions);
      return await this.getRecords({ conjunction: 'or', conditions });
    }

    const FIELD_BY_PLATFORM = { xiaohongshu: '小红书发布状态', douyin: '抖音发布状态' };
    const results = [];
    for (const platformKey of dualPlatforms) {
      const conditions = buildConditions(FIELD_BY_PLATFORM[platformKey]);
      const items = await this.getRecords({ conjunction: 'or', conditions }, platformKey);
      for (const item of items) item.__platform = platformKey;
      results.push(...items);
    }
    return results;
  }

  async getUnpublishedRecords() {
    // 服务端筛选：只拉「活跃」状态记录，避免全量拉取 500+ 条再客户端过滤。
    // 注：「发布状态」是计算字段，飞书不支持对它 filter；
    //     「小红书发布状态」和「抖音发布状态」是单选字段，支持 is 筛选。
    const ACTIVE_STATUSES = ['待发布', '发布中', '发布失败'];
    return await this._scanBothPlatforms(
      field_name => ACTIVE_STATUSES.map(status => ({ field_name, operator: 'is', value: [status] }))
    );
  }

  async getPendingRecords() {
    return await this._scanBothPlatforms(
      field_name => [{ field_name, operator: 'is', value: ['待发布'] }]
    );
  }

  // 通用"扫全部记录"入口：双表模式下分别扫小红书表/抖音表并合并（每条打上 __platform），
  // 旧版单表模式下等价于直接 getRecords(filter)，零行为变化。
  // 供 server.js 里那些原本"不区分平台、扫整张表"的场景使用
  // （/api/pending-count、/api/records?status=all、/api/all-records、主题间隔检查等）。
  async getRecordsAcrossPlatforms(filter) {
    const dualPlatforms = this._configuredDualPlatforms();
    if (dualPlatforms.length === 0) {
      return await this.getRecords(filter);
    }
    const results = [];
    for (const platformKey of dualPlatforms) {
      const items = await this.getRecords(filter, platformKey);
      for (const item of items) item.__platform = platformKey;
      results.push(...items);
    }
    return results;
  }

  async getRecordsByPlatformStatus(platform, status) {
    const field_name = platform === '小红书' ? '小红书发布状态' : '抖音发布状态';
    return await this.getRecords({
      conjunction: 'and',
      conditions: [{ field_name, operator: 'is', value: [status] }],
    }, platform);
  }

  // platform 未传时按旧版单表解析（不做字段白名单过滤，原样透传，零行为变化）；
  // 传入后按该平台对应的表解析，并按平台字段白名单过滤 fields——平台专属字段只写
  // 对应表，公共字段两表都写，残留字段（如小红书表里的"抖音发布人"）一律不写。
  // 过滤后若 fields 变为空对象（原本只想写残留/对方平台字段），直接跳过网络请求，
  // 视为无操作成功——效果等同于旧代码里对 code=1254045(字段不存在) 的静默跳过。
  async updateRecord(recordId, fields, platform) {
    const { appToken, tableId, platformKey } = this._resolveTable(platform);
    const { fields: filteredFields, dropped } = filterFieldsForPlatform(fields, platformKey);
    if (dropped.length > 0) {
      console.log(`[feishu] updateRecord(${recordId}) 按${PLATFORM_LABEL[platformKey] || platformKey}表字段白名单过滤，已丢弃: ${dropped.join(',')}`);
    }
    if (platformKey && Object.keys(filteredFields).length === 0 && Object.keys(fields || {}).length > 0) {
      return; // 全部字段都不属于这张表，视为无操作成功
    }

    const resp = await this.requestWithRetry(token =>
      axios.put(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
        { fields: filteredFields },
        { headers: { Authorization: `Bearer ${token}` } }
      )
    );
    // 同 createRecord:飞书 HTTP 200 不代表业务成功,必须检查 code
    const data = resp.data || {};
    if (data.code && data.code !== 0) {
      const err = new Error(`飞书 updateRecord 失败: code=${data.code} msg=${data.msg || '未知'} (recordId=${recordId})`);
      err.feishuCode = data.code;
      err.feishuMsg = data.msg;
      err.feishuFields = filteredFields;
      throw err;
    }
  }

  async markPublished(recordId, platform) {
    try {
      await this.updateRecord(recordId, { '发布状态': '已发布' }, platform);
    } catch (e) {
      if (e.feishuCode === 1254045) return; // 发布状态字段不存在，跳过
      throw e;
    }
  }

  async markPlatformStatus(recordId, platform, status) {
    const fieldName = platform === '小红书' ? '小红书发布状态' : '抖音发布状态';
    try {
      await this.updateRecord(recordId, { [fieldName]: status }, platform);
    } catch (error) {
      try {
        await this.syncSingleSelectFieldOptions(fieldName, ['待发布', '发布中', '已发布', '发布失败'], {
          keepExisting: true,
        }, platform);
        await this.updateRecord(recordId, { [fieldName]: status }, platform);
      } catch (_) {
        throw error;
      }
    }
  }

  async markFailed(recordId, reason, platform) {
    try {
      await this.updateRecord(recordId, { '备注': reason }, platform);
    } catch (e) {
      if (e.feishuCode === 1254045) return; // 备注字段不存在，跳过
      throw e;
    }
  }

  async setNote(recordId, note, platform) {
    try {
      await this.updateRecord(recordId, { '备注': note || '' }, platform);
    } catch (e) {
      if (e.feishuCode === 1254045) return; // 备注字段不存在，跳过
      throw e;
    }
  }

  async downloadAttachment(fileToken, destDir) {
    // 获取临时下载URL（自动处理 token 失效重试）
    const urlResp = await this.requestWithRetry(token =>
      axios.get(
        `https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url`,
        {
          params: { file_tokens: fileToken },
          headers: { Authorization: `Bearer ${token}` },
        }
      )
    );
    const tmpUrls = urlResp.data.data?.tmp_download_urls || [];
    if (tmpUrls.length === 0) throw new Error(`无法获取文件下载URL: ${fileToken}`);

    const downloadUrl = tmpUrls[0].tmp_download_url;
    const resp = await axios.get(downloadUrl, { responseType: 'arraybuffer' });

    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const filePath = path.join(destDir, `${fileToken}.tmp`);
    fs.writeFileSync(filePath, resp.data);
    return filePath;
  }

  async downloadAllAttachments(attachments, destDir) {
    if (!attachments || attachments.length === 0) return [];

    // 仅对”前缀就是数字”的文件名按数字排序，其余保持飞书原顺序，
    // 避免”封面 (3).png”或”课程封面_11.png”被误排到最前面。
    // 支持两种子序号风格（等价）：
    //   小数点：0.1 < 1 < 1.1 < 1.2 < 2 < 11 < 12
    //   括号：  1(1) < 1(2) / 1（1） < 1（2）（macOS/中文输入法重名风格）
    //          允许数字与括号间有空格："0 (4).png"
    const sorted = orderAttachmentsForDownload(attachments);

    const paths = [];
    // 用 Set 跟踪本批次内已使用的目标文件名，避免同名互相覆盖。
    // 历史教训（2026-04-09 Codex 审计）：原本 fs.renameSync 会直接覆盖目标文件，
    // 同一条记录里两张图都叫 "1.png" 时，第二张会把第一张本地文件覆盖掉，
    // 上传时 paths 数组里两个元素指向同一份内容 → 笔记里少一张图。
    // 此外 scheduler 早期让 attachments 与 videoCover 共用 tmpDir，封面与附件
    // 同名也会互相污染，scheduler 已改为子目录隔离，这里再加一道兜底。
    const usedNames = new Set();
    for (const att of sorted) {
      const filePath = await this.downloadAttachment(att.file_token, destDir);
      // 用原始文件名重命名（basename 防止路径穿越）
      const ext = path.extname(att.name) || '.png';
      const rawName = path.basename(att.name.includes('.') ? att.name : `${att.name}${ext}`);
      const dotIdx = rawName.lastIndexOf('.');
      const stem = dotIdx > 0 ? rawName.slice(0, dotIdx) : rawName;
      const tail = dotIdx > 0 ? rawName.slice(dotIdx) : '';

      // 同名去重：先看 usedNames，再看磁盘上是否已存在；都不冲突再用，
      // 否则在 stem 末尾追加 _2 / _3 ...。
      let candidate = rawName;
      let n = 2;
      while (
        usedNames.has(candidate) ||
        fs.existsSync(path.join(destDir, candidate))
      ) {
        candidate = `${stem}_${n}${tail}`;
        n += 1;
      }
      usedNames.add(candidate);

      const newPath = path.join(destDir, candidate);
      fs.renameSync(filePath, newPath);
      paths.push(newPath);
      if (candidate !== rawName) {
        console.log(`  📥 下载: ${att.name} → ${candidate}（同名去重）`);
      } else {
        console.log(`  📥 下载: ${att.name}`);
      }
    }
    return paths;
  }

  parseRecord(record) {
    const f = record.fields;
    // 从飞书字段值中提取纯文本。
    // 支持格式：string、number、富文本数组 [{text:...}]、
    // 以及公式/AI字段有时以 {value:...} 包装的格式。
    const getText = (field) => {
      if (!field) return '';
      if (typeof field === 'string') return field;
      if (typeof field === 'number') return String(field);
      // 公式字段 / AI 字段引用：有时以 {value: "str"} 或 {value: [{text:...}]} 包装
      if (!Array.isArray(field) && typeof field === 'object' && field.value !== undefined) {
        const v = field.value;
        if (typeof v === 'string') return v;
        if (typeof v === 'number') return String(v);
        if (Array.isArray(v)) return v.map(item => {
          if (typeof item === 'string') return item;
          return (item && typeof item === 'object') ? (item.text || '') : '';
        }).join('');
        return '';
      }
      if (Array.isArray(field)) return field.map(item => {
        if (typeof item === 'string') return item;
        return (item && typeof item === 'object') ? (item.text || '') : '';
      }).join('');
      if (field.text) return field.text;
      return '';
    };

    const getSelect = (field, fieldName = '') => {
      if (!field) return '';
      if (typeof field === 'string') return field;
      // R3 修复：账号字段如果被错误地配置成多选，会以数组形式返回。
      // 不能静默拼接或返回空字符串——直接抛错让调用层把这条记录跳过 + 写飞书备注。
      if (Array.isArray(field)) {
        throw new Error(`飞书字段 "${fieldName || '未知'}" 期望单选但返回了数组(${field.length}项)，请在飞书把字段类型改成"单选"`);
      }
      if (typeof field === 'object' && typeof field.text === 'string') return field.text;
      return '';
    };

    const splitTags = (str) => str
      .split(/[#\n,，]+/)
      .map(tag => tag.trim().replace(/^#+/, ''))
      .filter(Boolean);

    const getTagValues = (field) => {
      if (!field) return [];

      if (typeof field === 'string') return splitTags(field);

      // 公式/AI 字段以 {value: ...} 包装：先展开再按文本处理
      if (!Array.isArray(field) && typeof field === 'object' && field.value !== undefined) {
        const v = field.value;
        if (typeof v === 'string') return splitTags(v);
        if (Array.isArray(v)) {
          const joined = v.map(item => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') return item.text || item.name || '';
            return '';
          }).join('\n');
          return splitTags(joined);
        }
        return [];
      }

      if (Array.isArray(field)) {
        return field
          .map(item => {
            if (typeof item === 'string') return item;
            if (!item || typeof item !== 'object') return '';
            if (typeof item.text === 'string') return item.text;
            if (typeof item.name === 'string') return item.name;
            if (typeof item.value === 'string') return item.value;
            if (typeof item.label === 'string') return item.label;
            if (typeof item.title === 'string') return item.title;
            return '';
          })
          .map(tag => tag.trim().replace(/^#+/, ''))
          .filter(Boolean);
      }

      if (typeof field === 'object') {
        // field.value 是数组（多选选项）→ 不能直接 String(...)
        if (Array.isArray(field.value)) {
          return field.value.map(item => {
            if (typeof item === 'string') return item.replace(/^#+/, '').trim();
            if (item && typeof item === 'object') return (item.text || item.name || '').replace(/^#+/, '').trim();
            return '';
          }).filter(Boolean);
        }
        const candidate = field.text || field.name
          || (typeof field.value === 'string' ? field.value : null)
          || field.label || field.title;
        return candidate ? splitTags(String(candidate)) : [];
      }

      return [];
    };

    const tags = getTagValues(f['标签']);

    // 调试：打印公式字段原始格式（仅在标题为空时输出，避免日志过多）
    const rawTitle = f['标题'];
    if (!getText(rawTitle)) {
      console.log(`[DEBUG parseRecord] 标题字段原始值 (recordId=${record.record_id}):`, JSON.stringify(rawTitle));
    }

    // 解析发布时间
    let publishTime = null;
    if (f['发布时间']) {
      publishTime = typeof f['发布时间'] === 'number'
        ? new Date(f['发布时间'])
        : new Date(f['发布时间']);
    }

    return {
      recordId: record.record_id,
      title: getText(f['标题']),
      description: getText(f['正文']),
      tags,
      contentType: getSelect(f['内容类型'], '内容类型') || '图文',
      attachments: f['素材'] || [],
      videoCover: f['视频封面'] || [],
      xiaohongshuAccount: getSelect(f['小红书账号'], '小红书账号'),
      xiaohongshuPublishChannel: getSelect(f['小红书发布渠道'], '小红书发布渠道') || '蚁小二',
      douyinAccount: getSelect(f['抖音账号'], '抖音账号'),
      musicKeyword: getText(f['配乐关键词']),
      musicSongName: getText(f['指定歌曲名']),
      publishTime,
      published: getSelect(f['发布状态'], '发布状态') === '已发布',
      xiaohongshuStatus: getSelect(f['小红书发布状态'], '小红书发布状态'),
      douyinStatus: getSelect(f['抖音发布状态'], '抖音发布状态'),
      note: getText(f['备注']),
      topic: getText(f['笔记主题']),
      // 双表模式下由 _scanBothPlatforms() 打在原始记录上的 __platform 标记
      // ('xiaohongshu'|'douyin') 转成中文标签透出；旧版单表模式下为 null。
      // 下游（scheduler.js/server.js）据此把后续写操作路由回记录来源的那张表。
      platform: record.__platform ? (PLATFORM_LABEL[record.__platform] || record.__platform) : null,
      createdTime: record.created_time || 0,
      // 飞书 records/search 返回 `last_modified_time`（需请求体 automatic_fields:true）。
      // 旧字段名 `modified_time` 已不再返回，保留兼容兜底。
      modifiedTime: record.last_modified_time || record.modified_time || null,
    };
  }

  async getTableFields(platform) {
    const { appToken, tableId } = this._resolveTable(platform);
    const resp = await this.requestWithRetry(token =>
      axios.get(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
    );
    return (resp.data.data?.items || []).map(item => item.field_name);
  }

  // 在多维表格中新建一个文本类型字段（type=1）
  // 用于导入功能自动创建「导入指纹」等辅助字段
  async createTextField(fieldName, platform) {
    const { appToken, tableId } = this._resolveTable(platform);
    const resp = await this.requestWithRetry(token =>
      axios.post(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
        { field_name: fieldName, type: 1 },
        { headers: { Authorization: `Bearer ${token}` } }
      )
    );
    const data = resp.data || {};
    if (data.code && data.code !== 0) {
      throw new Error(`飞书创建字段「${fieldName}」失败: code=${data.code} msg=${data.msg || '未知'}`);
    }
    return data.data?.field?.field_name || fieldName;
  }

  // platform 未传时按旧版单表解析，fields 原样透传（零行为变化）；
  // 传入后按平台字段白名单过滤——道理同 updateRecord()。
  async createRecord(fields, platform) {
    const { appToken, tableId, platformKey } = this._resolveTable(platform);
    const { fields: filteredFields, dropped } = filterFieldsForPlatform(fields, platformKey);
    if (dropped.length > 0) {
      console.log(`[feishu] createRecord 按${PLATFORM_LABEL[platformKey] || platformKey}表字段白名单过滤，已丢弃: ${dropped.join(',')}`);
    }
    const resp = await this.requestWithRetry(token =>
      axios.post(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
        { fields: filteredFields },
        { headers: { Authorization: `Bearer ${token}` } }
      )
    );
    // 飞书 API 即使 HTTP 200 也可能返回业务错误(code != 0)。
    // 此前实现用 `?.||''` 静默吞噬,导致 server.js 误报 success 但飞书实际未建单。
    // 修复:遇到业务错误或 record_id 缺失,都抛出明确异常给上层。
    const data = resp.data || {};
    if (data.code && data.code !== 0) {
      const err = new Error(`飞书 createRecord 失败: code=${data.code} msg=${data.msg || '未知'}`);
      err.feishuCode = data.code;
      err.feishuMsg = data.msg;
      err.feishuFields = filteredFields; // 排查用,server 端可写诊断日志
      throw err;
    }
    const recordId = data.data?.record?.record_id;
    if (!recordId) {
      const err = new Error(`飞书 createRecord 返回 200 但没有 record_id (响应: ${JSON.stringify(data).slice(0, 500)})`);
      err.feishuFields = filteredFields;
      throw err;
    }
    return { recordId };
  }

  // imagePaths: string[] - 待上传的本地图片绝对路径
  // options.concurrency: 并发数,默认 3(飞书 medias/upload_all 默认 QPS 50,3 路远低于阈值)
  // options.onProgress: (done, total, currentItem, fromCache) => void  每张完成后回调
  // options.useRecovery: 是否启用断点续传缓存,默认 true。整批中途失败时已成功的会被
  //   缓存,用户重试时跳过这些图,只重传失败的。文件 size/mtime 任一变化即视为新图。
  // options.platform: 双表模式下上传目标平台('小红书'/'抖音'/'xiaohongshu'/'douyin')。
  //   附件必须以目标表所在 app 的 appToken 作为 parent_node 上传,否则记录写入时
  //   file_token 与表格所属 app 不一致会失败。未传时按旧版单表解析。
  // 返回值顺序与 imagePaths 输入顺序严格一致(mapWithConcurrency 按 index 写回)
  // TODO(B4 冷眼审查 P0-4): cache hit 时未把 _meta.truncated 透出,需要在 server 层补齐
  async uploadLocalImagesToFeishu(imagePaths, options = {}) {
    const crypto = require('crypto');
    const FormData = require('form-data');
    const list = Array.isArray(imagePaths) ? imagePaths : [];
    if (list.length === 0) return [];

    const { appToken: uploadAppToken } = this._resolveTable(options.platform);
    const concurrency = Math.max(1, Number(options.concurrency) || 3);
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const useRecovery = options.useRecovery !== false; // 默认启用
    let doneCount = 0;
    const total = list.length;
    const recoveryCache = useRecovery ? getRecovery() : null;
    const now = Date.now();
    let recoveryDirty = false;

    const tryRecover = (imagePath) => {
      if (!recoveryCache) return null;
      const key = makeRecoveryKey(imagePath, uploadAppToken);
      const entry = recoveryCache[key];
      if (!entry || !entry.fileToken) return null;
      // 过期(>24h)清理掉
      if (entry.uploadedAt && now - entry.uploadedAt > RECOVERY_TTL_MS) {
        delete recoveryCache[key];
        recoveryDirty = true;
        return null;
      }
      return entry.fileToken;
    };

    const recordRecovery = (imagePath, fileToken) => {
      if (!recoveryCache || !fileToken) return;
      const key = makeRecoveryKey(imagePath, uploadAppToken);
      recoveryCache[key] = { fileToken, uploadedAt: Date.now() };
      recoveryDirty = true;
    };

    const MULTIPART_THRESHOLD = 20 * 1024 * 1024; // 20MB: media/upload_all 上限
    const BLOCK_SIZE = 4 * 1024 * 1024; // 4MB per block

    const uploadOne = async (imagePath) => {
      const originalName = path.basename(imagePath);

      if (!fs.existsSync(imagePath)) {
        throw new Error(`文件不存在: ${imagePath}`);
      }
      let stat;
      try {
        stat = fs.statSync(imagePath);
      } catch (e) {
        throw new Error(`无法读取文件信息: ${imagePath}: ${e.message}`);
      }
      if (stat.size === 0) {
        throw new Error(`文件为空 (0 字节): ${imagePath}`);
      }

      const safeFileName = `${crypto.randomBytes(6).toString('hex')}_${originalName}`;

      if (stat.size > MULTIPART_THRESHOLD) {
        return await uploadLargeFile(imagePath, safeFileName, stat.size);
      }

      const stream = fs.createReadStream(imagePath);
      let streamError = null;
      stream.once('error', (e) => { streamError = e; });

      const form = new FormData();
      form.append('file_name', safeFileName);
      form.append('parent_type', 'bitable_file');
      form.append('parent_node', uploadAppToken);
      form.append('size', stat.size);
      form.append('file', stream);

      const resp = await this.requestWithRetry(token =>
        axios.post(
          'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
          form,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              ...form.getHeaders(),
            },
          }
        )
      );

      if (streamError) {
        throw new Error(`文件读取失败(传输中断): ${imagePath}: ${streamError.message}`);
      }

      const data = resp.data || {};
      if (data.code && data.code !== 0) {
        throw new Error(`飞书上传失败: code=${data.code} msg=${data.msg || '未知'} (${imagePath})`);
      }
      const fileToken = data.data?.file_token;
      if (!fileToken) {
        throw new Error(`飞书上传返回空 fileToken (${imagePath}): ${JSON.stringify(data).slice(0, 200)}`);
      }

      return { originalName, fileToken };
    };

    const uploadLargeFile = async (filePath, fileName, fileSize) => {
      const originalName = path.basename(filePath);
      const blockNum = Math.ceil(fileSize / BLOCK_SIZE);

      // Step 1: upload_prepare
      const prepResp = await this.requestWithRetry(token =>
        axios.post(
          'https://open.feishu.cn/open-apis/drive/v1/medias/upload_prepare',
          { file_name: fileName, parent_type: 'bitable_file', parent_node: uploadAppToken, size: fileSize },
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        )
      );
      const prepData = prepResp.data || {};
      if (prepData.code && prepData.code !== 0) {
        throw new Error(`分片上传 prepare 失败: code=${prepData.code} msg=${prepData.msg || '未知'} (${filePath})`);
      }
      const uploadId = prepData.data?.upload_id;
      if (!uploadId) {
        throw new Error(`分片上传 prepare 返回空 upload_id (${filePath})`);
      }

      // Step 2: upload_part for each block
      const fd = fs.openSync(filePath, 'r');
      try {
        for (let seq = 0; seq < blockNum; seq++) {
          const offset = seq * BLOCK_SIZE;
          const length = Math.min(BLOCK_SIZE, fileSize - offset);
          const buf = Buffer.alloc(length);
          fs.readSync(fd, buf, 0, length, offset);

          // 飞书要求 Adler-32 校验和
          let a = 1, b = 0;
          const MOD = 65521;
          for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % MOD; b = (b + a) % MOD; }
          const checksum = String(((b << 16) | a) >>> 0);

          const form = new FormData();
          form.append('upload_id', uploadId);
          form.append('seq', seq);
          form.append('size', length);
          form.append('checksum', checksum);
          form.append('file', buf, { filename: `part_${seq}`, contentType: 'application/octet-stream' });

          const partResp = await this.requestWithRetry(token =>
            axios.post(
              'https://open.feishu.cn/open-apis/drive/v1/medias/upload_part',
              form,
              { headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() } }
            )
          );
          const partData = partResp.data || {};
          if (partData.code && partData.code !== 0) {
            throw new Error(`分片上传 part ${seq}/${blockNum} 失败: code=${partData.code} msg=${partData.msg || '未知'} (${filePath})`);
          }
        }
      } finally {
        fs.closeSync(fd);
      }

      // Step 3: upload_finish
      const finResp = await this.requestWithRetry(token =>
        axios.post(
          'https://open.feishu.cn/open-apis/drive/v1/medias/upload_finish',
          { upload_id: uploadId, block_num: blockNum },
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        )
      );
      const finData = finResp.data || {};
      if (finData.code && finData.code !== 0) {
        throw new Error(`分片上传 finish 失败: code=${finData.code} msg=${finData.msg || '未知'} (${filePath})`);
      }
      const fileToken = finData.data?.file_token;
      if (!fileToken) {
        throw new Error(`分片上传 finish 返回空 fileToken (${filePath}): ${JSON.stringify(finData).slice(0, 200)}`);
      }

      return { originalName, fileToken };
    };

    try {
      return await mapWithConcurrency(list, concurrency, async (imagePath) => {
        const originalName = path.basename(imagePath);
        // 优先查 recovery cache
        const cachedToken = tryRecover(imagePath);
        if (cachedToken) {
          doneCount += 1;
          if (onProgress) {
            try { onProgress(doneCount, total, originalName, true /* fromCache */); } catch (_) {}
          }
          return { originalName, fileToken: cachedToken };
        }
        // cache miss → 真上传
        const result = await uploadOne(imagePath);
        recordRecovery(imagePath, result.fileToken);
        doneCount += 1;
        if (onProgress) {
          try { onProgress(doneCount, total, result.originalName, false); } catch (_) {}
        }
        return result;
      });
    } finally {
      // 无论成功还是失败,把已记录的 recovery 落盘(失败时尤其重要,
      // 让用户重试时能跳过已成功的图)
      // TODO(B4 冷眼审查 P1-1): persistRecovery 失败被静默 catch,改 console.error
      if (recoveryDirty) {
        try { persistRecovery(); } catch (_) {}
      }
    }
  }

  // 整批导入完成后,清掉本批用过的 recovery 条目,避免长期堆积。
  // 调用时机:server.js 在 create-records 全部 records 处理完后调用。
  // TODO(B4 冷眼审查 P0-1): 同图被两条记录引用时会误删失败记录的 cache,
  // 需要 Map<imagePath, Set<noteKey>> 反向索引,只清"全部 noteKey 都成功"的图
  //
  // 调用方(server.js)只传 imagePaths,拿不到 platform/appToken,而 makeRecoveryKey
  // 现在带 scope 前缀(`${scope}|${imagePath}|${size}|${mtime}`)。这里按"后缀匹配"清理:
  // 对每个 imagePath 算出不含 scope 的后缀 `|${imagePath}|${size}|${mtime}`,遍历 cache
  // 所有 key,凡是以该后缀结尾的一并删掉——这样同一张图在双表模式下留下的多个 scope
  // 缓存条目会被一起清干净,不需要改调用方签名。
  clearImportRecoveryFor(imagePaths) {
    if (!Array.isArray(imagePaths) || imagePaths.length === 0) return;
    const cache = getRecovery();
    let dirty = false;
    for (const p of imagePaths) {
      let suffix;
      try {
        const stat = fs.statSync(p);
        suffix = `|${p}|${stat.size}|${Math.floor(stat.mtimeMs)}`;
      } catch (_) {
        suffix = `|${p}`;
      }
      for (const key of Object.keys(cache)) {
        if (key.endsWith(suffix)) {
          delete cache[key];
          dirty = true;
        }
      }
    }
    if (dirty) {
      try { persistRecovery(); } catch (_) {}
    }
  }

  async findRecordByFingerprint(fingerprint, platform) {
    // 使用 contains 而非 is，兼容历史记录里同一字段存储多个指纹（换行分隔）
    // 若用户表格不存在「导入指纹」字段，飞书 search API 返回空结果或报错——均优雅降级
    const { appToken, tableId } = this._resolveTable(platform);
    try {
      const resp = await this.requestWithRetry(token =>
        axios.post(
          `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/search`,
          {
            filter: {
              conjunction: 'and',
              conditions: [
                { field_name: '导入指纹', operator: 'contains', value: [fingerprint] }
              ],
            },
            page_size: 1,
          },
          { headers: { Authorization: `Bearer ${token}` } }
        )
      );
      const items = resp.data.data?.items || [];
      return items[0]?.record_id || null;
    } catch (_) {
      // 「导入指纹」字段不存在或网络失败时，返回 null（跳过查重，继续导入）
      return null;
    }
  }
}

module.exports = FeishuClient;
module.exports.makeRecoveryKey = makeRecoveryKey;
module.exports.parseAttachmentSortKey = parseAttachmentSortKey;
module.exports.orderAttachmentsForDownload = orderAttachmentsForDownload;
module.exports.normalizePlatformKey = normalizePlatformKey;
module.exports.filterFieldsForPlatform = filterFieldsForPlatform;
module.exports.COMMON_FEISHU_FIELDS = COMMON_FEISHU_FIELDS;
module.exports.PLATFORM_ONLY_FEISHU_FIELDS = PLATFORM_ONLY_FEISHU_FIELDS;
