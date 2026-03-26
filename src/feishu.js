const axios = require('axios');
const fs = require('fs');
const path = require('path');

class FeishuClient {
  constructor(config) {
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
    await this.updateRecord(recordId, { [fieldName]: status });
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

    // 仅对“前缀就是数字”的文件名按数字排序，其余保持飞书原顺序，
    // 避免“封面 (3).png”或“课程封面_11.png”被误排到最前面。
    const sorted = [...attachments]
      .map((att, index) => ({ att, index }))
      .sort((left, right) => {
        const leftName = path.basename(String(left.att.name || ''));
        const rightName = path.basename(String(right.att.name || ''));
        const leftMatch = leftName.match(/^(\d+)/);
        const rightMatch = rightName.match(/^(\d+)/);
        const leftNumber = leftMatch ? Number(leftMatch[1]) : null;
        const rightNumber = rightMatch ? Number(rightMatch[1]) : null;

        if (leftNumber !== null && rightNumber !== null) {
          return leftNumber - rightNumber || left.index - right.index;
        }

        if (leftNumber !== null) return -1;
        if (rightNumber !== null) return 1;
        return left.index - right.index;
      })
      .map(item => item.att);

    const paths = [];
    for (const att of sorted) {
      const filePath = await this.downloadAttachment(att.file_token, destDir);
      // 用原始文件名重命名（basename 防止路径穿越）
      const ext = path.extname(att.name) || '.png';
      const safeName = path.basename(att.name.includes('.') ? att.name : `${att.name}${ext}`);
      const newPath = path.join(destDir, safeName);
      fs.renameSync(filePath, newPath);
      paths.push(newPath);
      console.log(`  📥 下载: ${att.name}`);
    }
    return paths;
  }

  parseRecord(record) {
    const f = record.fields;
    const getText = (field) => {
      if (!field) return '';
      if (typeof field === 'string') return field;
      if (Array.isArray(field)) return field.map(item => item.text || item).join('');
      if (field.text) return field.text;
      return '';
    };

    const getSelect = (field) => {
      if (!field) return '';
      if (typeof field === 'string') return field;
      if (field.text) return field.text;
      return '';
    };

    const getTagValues = (field) => {
      if (!field) return [];

      if (typeof field === 'string') {
        return field
          .split(/[#\n,，\s]+/)
          .map(tag => tag.trim())
          .filter(Boolean);
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
          .map(tag => tag.trim())
          .filter(Boolean)
          .map(tag => tag.replace(/^#+/, ''));
      }

      if (typeof field === 'object') {
        const candidate = field.text || field.name || field.value || field.label || field.title;
        return candidate ? [String(candidate).replace(/^#+/, '').trim()].filter(Boolean) : [];
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
      contentType: getSelect(f['内容类型']) || '图文',
      attachments: f['素材'] || [],
      videoCover: f['视频封面'] || [],
      xiaohongshuAccount: getSelect(f['小红书账号']),
      xiaohongshuPublishChannel: getSelect(f['小红书发布渠道']) || '蚁小二',
      douyinAccount: getSelect(f['抖音账号']),
      musicKeyword: getText(f['配乐关键词']),
      musicSongName: getText(f['指定歌曲名']),
      publishTime,
      published: getSelect(f['发布状态']) === '已发布',
      xiaohongshuStatus: getSelect(f['小红书发布状态']),
      douyinStatus: getSelect(f['抖音发布状态']),
      note: getText(f['备注']),
    };
  }
}

module.exports = FeishuClient;
