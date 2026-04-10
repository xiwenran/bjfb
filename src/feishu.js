const axios = require('axios');
const fs = require('fs');
const path = require('path');

class FeishuClient {
  constructor(config = {}) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.appToken = config.appToken;
    this.tableId = config.tableId;
    this.accessToken = null;
    this.tokenExpiry = 0;
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

  // 自动处理 401：token 失效时强制刷新后重试一次
  async requestWithRetry(fn) {
    try {
      return await fn(await this.getAccessToken());
    } catch (e) {
      if (e.response?.status === 401) {
        return await fn(await this.getAccessToken(true));
      }
      throw e;
    }
  }

  async getRecords(filter) {
    const items = [];
    let pageToken;
    let hasMore = true;

    while (hasMore) {
      const body = { page_size: 100 };
      if (filter) body.filter = filter;
      if (pageToken) body.page_token = pageToken;

      const resp = await this.requestWithRetry(token =>
        axios.post(
          `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.appToken}/tables/${this.tableId}/records/search`,
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

  // 根据 recordId 拉取单条最新记录。供 scheduler 在发布前做"二次校验账号字段"使用。
  async getRecordById(recordId) {
    if (!recordId) return null;
    const token = await this.getAccessToken();
    const resp = await axios.get(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.appToken}/tables/${this.tableId}/records/${recordId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return resp.data?.data?.record || null;
  }

  // 启动期校验关键字段必须是 type=3 (单选)。
  // 任何一个字段不是单选 → 抛错；调用方负责让进程退出。
  async assertSingleSelectFields(fieldNames) {
    const fields = await this.getFields();
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

  async getFields() {
    const items = [];
    let pageToken;
    let hasMore = true;

    while (hasMore) {
      const resp = await this.requestWithRetry(token =>
        axios.get(
          `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.appToken}/tables/${this.tableId}/fields`,
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

  async updateField(fieldId, body) {
    const resp = await this.requestWithRetry(token =>
      axios.put(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.appToken}/tables/${this.tableId}/fields/${fieldId}`,
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

  async syncSingleSelectFieldOptions(fieldName, targetNames = [], options = {}) {
    const fields = await this.getFields();
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
    });
  }

  async getSingleSelectFieldOptionNames(fieldName) {
    const fields = await this.getFields();
    const field = fields.find(item => item.field_name === fieldName);
    if (!field || field.type !== 3) return [];
    return (field.property?.options || [])
      .map(option => String(option.name || '').trim())
      .filter(Boolean);
  }

  async getUnpublishedRecords() {
    const records = await this.getRecords();
    return records.filter(r => {
      const fields = r.fields;
      const status = fields['发布状态'];
      const normalizedStatus = typeof status === 'string'
        ? status
        : (status && typeof status.text === 'string' ? status.text : '');
      return normalizedStatus !== '已发布';
    });
  }

  async getRecordsByPlatformStatus(platform, status) {
    const fieldName = platform === '小红书' ? '小红书发布状态' : '抖音发布状态';
    const records = await this.getRecords();
    return records.filter(r => {
      const field = r.fields[fieldName];
      const val = typeof field === 'string' ? field : (field?.text || '');
      return val === status;
    });
  }

  async updateRecord(recordId, fields) {
    await this.requestWithRetry(token =>
      axios.put(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.appToken}/tables/${this.tableId}/records/${recordId}`,
        { fields },
        { headers: { Authorization: `Bearer ${token}` } }
      )
    );
  }

  async markPublished(recordId) {
    await this.updateRecord(recordId, { '发布状态': '已发布' });
  }

  async markPlatformStatus(recordId, platform, status) {
    const fieldName = platform === '小红书' ? '小红书发布状态' : '抖音发布状态';
    try {
      await this.updateRecord(recordId, { [fieldName]: status });
    } catch (error) {
      try {
        await this.syncSingleSelectFieldOptions(fieldName, ['待发布', '发布中', '已发布', '发布失败'], {
          keepExisting: true,
        });
        await this.updateRecord(recordId, { [fieldName]: status });
      } catch (_) {
        throw error;
      }
    }
  }

  async markFailed(recordId, reason) {
    await this.updateRecord(recordId, { '备注': reason });
  }

  async setNote(recordId, note) {
    await this.updateRecord(recordId, { '备注': note || '' });
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
    //   括号：  1(1) < 1(2)（macOS 重名风格）
    const parseSortKey = (name) => {
      // 小数点风格：”1.2.png” → [1, 2]；”0.1.png” → [0, 1]
      const dec = name.match(/^(\d+)\.(\d+)/);
      if (dec) return [Number(dec[1]), Number(dec[2])];
      // 括号风格：”1(2).png” → [1, 2]；”1.png” → [1, -1]
      const paren = name.match(/^(\d+)(?:\((\d+)\))?/);
      if (paren) return [Number(paren[1]), paren[2] != null ? Number(paren[2]) : -1];
      return null;
    };

    const sorted = [...attachments]
      .map((att, index) => ({ att, index }))
      .sort((left, right) => {
        const leftName = path.basename(String(left.att.name || ''));
        const rightName = path.basename(String(right.att.name || ''));
        const leftKey = parseSortKey(leftName);
        const rightKey = parseSortKey(rightName);

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
    };
  }
}

module.exports = FeishuClient;
