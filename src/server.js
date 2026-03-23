const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const Scheduler = require('./scheduler.js');
const publisher = require('./publisher.js');
const FeishuClient = require('./feishu.js');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
const PORT = 3210;

const scheduler = new Scheduler(config);
const feishu = new FeishuClient(config.feishu);

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

async function getBitBrowserAccountMappings() {
  const records = await feishu.getRecords();
  const parsedRecords = records.map(r => feishu.parseRecord(r));
  const summaryMap = new Map();

  for (const record of parsedRecords) {
    const accountName = (record.xiaohongshuAccount || '').trim();
    if (!accountName) continue;

    if (!summaryMap.has(accountName)) {
      summaryMap.set(accountName, {
        accountName,
        totalRecords: 0,
        bitbrowserRecords: 0,
      });
    }

    const item = summaryMap.get(accountName);
    item.totalRecords += 1;
    if (record.xiaohongshuPublishChannel === '比特浏览器') {
      item.bitbrowserRecords += 1;
    }
  }

  const mappingConfig = config.bitbrowser?.xiaohongshu || {};
  const fieldAccountNames = await feishu.getSingleSelectFieldOptionNames('小红书账号');
  for (const accountName of fieldAccountNames) {
    if (!summaryMap.has(accountName)) {
      summaryMap.set(accountName, {
        accountName,
        totalRecords: 0,
        bitbrowserRecords: 0,
      });
    }
  }
  for (const accountName of Object.keys(mappingConfig)) {
    if (!summaryMap.has(accountName)) {
      summaryMap.set(accountName, {
        accountName,
        totalRecords: 0,
        bitbrowserRecords: 0,
      });
    }
  }

  return Array.from(summaryMap.values())
    .sort((a, b) => a.accountName.localeCompare(b.accountName, 'zh-CN'))
    .map(item => ({
      ...item,
      browserId: mappingConfig[item.accountName]?.browserId || '',
      configured: !!mappingConfig[item.accountName]?.browserId,
    }));
}

async function syncFeishuSelectFields() {
  const accountNames = [...new Set([
    ...Object.keys(config.accountMapping?.xiaohongshu || {}),
    ...Object.keys(config.bitbrowser?.xiaohongshu || {}),
    ...(await getBitBrowserAccountMappings()).map(item => item.accountName),
  ])].sort((a, b) => a.localeCompare(b, 'zh-CN'));

  await feishu.syncSingleSelectFieldOptions('小红书账号', accountNames, { keepExisting: true });
  await feishu.syncSingleSelectFieldOptions('小红书发布渠道', ['蚁小二', '比特浏览器']);

  return {
    accountNames,
    channels: ['蚁小二', '比特浏览器'],
  };
}

function getPrimaryDouyinAccountId() {
  const douyinAccounts = Object.values(config.accountMapping?.douyin || {});
  if (douyinAccounts.length === 0) {
    throw new Error('未配置抖音账号');
  }
  return douyinAccounts[0];
}

function decorateRecord(record) {
  const xiaohongshuPublishChannel = record.xiaohongshuPublishChannel === '比特浏览器' ? '比特浏览器' : '蚁小二';
  return {
    ...record,
    xiaohongshuPublishChannel,
    publishRoutePreview: {
      xiaohongshu: record.xiaohongshuAccount
        ? `${xiaohongshuPublishChannel} · ${record.xiaohongshuAccount}`
        : '',
      douyin: record.douyinAccount ? `蚁小二 · ${record.douyinAccount}` : '',
    },
    previewTags: {
      xiaohongshu: publisher.selectTagsForPlatform('小红书', record.tags, record.title),
      douyin: publisher.selectTagsForPlatform('抖音', record.tags, record.title),
    }
  };
}

// SSE clients for real-time log updates
const sseClients = new Set();
scheduler.onLog = (entry) => {
  const data = JSON.stringify(entry);
  for (const res of sseClients) {
    res.write(`data: ${data}\n\n`);
  }
};
scheduler.onProgress = (progress) => {
  const data = JSON.stringify(progress);
  for (const res of sseClients) {
    res.write(`event: progress\ndata: ${data}\n\n`);
  }
};

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function sendHtml(res, filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // 静态文件
  if (pathname === '/' || pathname === '/index.html') {
    return sendHtml(res, path.join(__dirname, '..', 'public', 'index.html'));
  }

  // SSE 实时日志
  if (pathname === '/api/logs/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // API 路由
  if (pathname === '/api/status') {
    return sendJson(res, scheduler.getStatus());
  }

  if (pathname === '/api/records') {
    try {
      const records = await feishu.getUnpublishedRecords();
      const parsed = records.map(r => decorateRecord(feishu.parseRecord(r)));
      return sendJson(res, { success: true, data: parsed });
    } catch (e) {
      return sendJson(res, { success: false, error: e.message }, 500);
    }
  }

  if (pathname === '/api/all-records') {
    try {
      const records = await feishu.getRecords();
      const parsed = records.map(r => decorateRecord(feishu.parseRecord(r)));
      return sendJson(res, { success: true, data: parsed });
    } catch (e) {
      return sendJson(res, { success: false, error: e.message }, 500);
    }
  }

  if (pathname === '/api/scheduler/start' && req.method === 'POST') {
    scheduler.start();
    return sendJson(res, { success: true, message: '定时服务已启动' });
  }

  if (pathname === '/api/scheduler/stop' && req.method === 'POST') {
    scheduler.stop();
    return sendJson(res, { success: true, message: '定时服务已停止' });
  }

  if (pathname === '/api/publish/now' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const result = await scheduler.checkAndPublish();
        if (result && result.error) {
          return sendJson(res, { success: false, ...result }, 500);
        }
        sendJson(res, { success: true, ...result });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
    });
    return;
  }

  if (pathname === '/api/accounts') {
    try {
      await publisher.ensureLogin(config.yixiaoer);
      const accounts = await publisher.getAccountList({ loginStatus: 1 });
      return sendJson(res, { success: true, data: accounts });
    } catch (e) {
      return sendJson(res, { success: false, error: e.message }, 500);
    }
  }

  if (pathname === '/api/accounts/status') {
    try {
      await publisher.ensureLogin(config.yixiaoer);
      const accounts = await publisher.getAccountList();
      const mappedIds = new Set([
        ...Object.values(config.accountMapping?.xiaohongshu || {}),
        ...Object.values(config.accountMapping?.douyin || {}),
      ]);
      const data = accounts.map(account => ({
        id: account.id,
        platform: account.platformName,
        accountName: account.platformAccountName,
        status: account.status,
        isFreeze: !!account.isFreeze,
        isOperate: account.isOperate !== false,
        isRealNameVerified: account.isRealNameVerified !== false,
        statusText: account.status === 1 && !account.isFreeze && account.isOperate !== false
          ? '在线/授权正常'
          : '需关注',
        mapped: mappedIds.has(account.id),
      }));
      return sendJson(res, { success: true, data });
    } catch (e) {
      return sendJson(res, { success: false, error: e.message }, 500);
    }
  }

  if (pathname === '/api/config') {
    if (req.method === 'GET') {
      const safeConfig = JSON.parse(JSON.stringify(config));
      if (safeConfig.yixiaoer.password) safeConfig.yixiaoer.password = '******';
      if (safeConfig.yixiaoer.apiKey) safeConfig.yixiaoer.apiKey = '******';
      if (safeConfig.yixiaoer.clientId) safeConfig.yixiaoer.clientId = '******';
      safeConfig.feishu.appSecret = '******';
      return sendJson(res, safeConfig);
    }
  }

  if (pathname === '/api/bitbrowser/accounts' && req.method === 'GET') {
    try {
      const data = await getBitBrowserAccountMappings();
      return sendJson(res, { success: true, data });
    } catch (e) {
      return sendJson(res, { success: false, error: e.message }, 500);
    }
  }

  if (pathname === '/api/bitbrowser/accounts' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { mappings } = JSON.parse(body || '{}');
        if (!Array.isArray(mappings)) {
          return sendJson(res, { success: false, error: '映射数据格式错误' }, 400);
        }

        config.bitbrowser = config.bitbrowser || {};
        config.bitbrowser.xiaohongshu = config.bitbrowser.xiaohongshu || {};

        for (const item of mappings) {
          const accountName = String(item.accountName || '').trim();
          if (!accountName) continue;
          const browserId = String(item.browserId || '').trim();

          if (!browserId) {
            delete config.bitbrowser.xiaohongshu[accountName];
            continue;
          }

          config.bitbrowser.xiaohongshu[accountName] = { browserId };
        }

        saveConfig();
        const data = await getBitBrowserAccountMappings();
        return sendJson(res, { success: true, message: '比特浏览器账号映射已保存', data });
      } catch (e) {
        return sendJson(res, { success: false, error: e.message }, 500);
      }
    });
    return;
  }

  if (pathname === '/api/bitbrowser/sync-feishu' && req.method === 'POST') {
    try {
      const synced = await syncFeishuSelectFields();
      const data = await getBitBrowserAccountMappings();
      return sendJson(res, {
        success: true,
        message: `已同步飞书单选字段：小红书账号(${synced.accountNames.length}个选项)、小红书发布渠道(2个选项)`,
        data,
      });
    } catch (e) {
      return sendJson(res, { success: false, error: e.message }, 500);
    }
  }

  // 更新定时配置
  if (pathname === '/api/schedule' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const schedule = JSON.parse(body);
        // 验证 periods 数组
        if (!Array.isArray(schedule.periods) || schedule.periods.length === 0) {
          return sendJson(res, { success: false, error: '至少需要一个时间段' }, 400);
        }
        if (schedule.periods.length > 10) {
          return sendJson(res, { success: false, error: '最多支持10个时间段' }, 400);
        }
        for (const p of schedule.periods) {
          if (!/^\d{2}:\d{2}$/.test(p.startTime) || !/^\d{2}:\d{2}$/.test(p.endTime)) {
            return sendJson(res, { success: false, error: '时间格式错误，应为 HH:MM' }, 400);
          }
          const interval = parseInt(p.intervalMinutes);
          if (isNaN(interval) || interval < 5 || interval > 480) {
            return sendJson(res, { success: false, error: '间隔应在5-480分钟之间' }, 400);
          }
          p.intervalMinutes = interval;
        }
        scheduler.updateSchedule(schedule);
        config.schedule = schedule;
        sendJson(res, { success: true, message: '定时配置已保存' });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
    });
    return;
  }

  // 音乐设置相关 API
  if (pathname === '/api/music/default/validate' && req.method === 'GET') {
    try {
      await publisher.ensureLogin(config.yixiaoer);
      const accountId = getPrimaryDouyinAccountId();
      const result = await publisher.resolveDouyinMusic(accountId, config.defaultMusic || null);
      return sendJson(res, {
        success: true,
        hasDefaultMusic: !!config.defaultMusic,
        configuredMusic: config.defaultMusic || null,
        valid: !!result.validDefault,
        fallbackUsed: !!result.fallbackUsed,
        fallbackKeyword: result.fallbackKeyword || null,
        activeMusic: result.music || null,
        message: result.message,
      });
    } catch (e) {
      return sendJson(res, { success: false, error: e.message }, 500);
    }
  }

  if (pathname === '/api/music/default') {
    if (req.method === 'GET') {
      return sendJson(res, {
        success: true,
        music: config.defaultMusic || null
      });
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { music } = JSON.parse(body);
          if (!music || !music.id || !music.text) {
            return sendJson(res, { success: false, error: '音乐数据格式错误' }, 400);
          }

          config.defaultMusic = music;
          saveConfig();

          sendJson(res, { success: true, message: '默认配乐已保存' });
        } catch (e) {
          sendJson(res, { success: false, error: e.message }, 500);
        }
      });
      return;
    }

    if (req.method === 'DELETE') {
      delete config.defaultMusic;
      saveConfig();
      return sendJson(res, { success: true, message: '默认配乐已清除' });
    }
  }

  if (pathname === '/api/music/search' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { keyword } = JSON.parse(body);
        if (!keyword || keyword.trim().length === 0) {
          return sendJson(res, { success: false, error: '搜索关键词不能为空' }, 400);
        }

        await publisher.ensureLogin(config.yixiaoer);
        const accountId = getPrimaryDouyinAccountId();
        const music = await publisher.searchMusicByAccount(accountId, keyword.trim());

        sendJson(res, {
          success: true,
          music: music || [],
          keyword: keyword.trim()
        });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
    });
    return;
  }

  if (pathname === '/api/music/categories' && req.method === 'GET') {
    try {
      await publisher.ensureLogin(config.yixiaoer);
      const accountId = getPrimaryDouyinAccountId();
      const categories = await publisher.getMusicCategories(accountId);
      return sendJson(res, {
        success: true,
        categories: categories || [],
      });
    } catch (e) {
      return sendJson(res, { success: false, error: e.message }, 500);
    }
  }

  if (pathname === '/api/music/library' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { keyword, nextPage, categoryId, categoryName } = body ? JSON.parse(body) : {};
        const normalizedKeyword = keyword ? String(keyword).trim() : '';
        await publisher.ensureLogin(config.yixiaoer);
        const accountId = getPrimaryDouyinAccountId();
        const result = await publisher.browseMusicByAccount(accountId, {
          keyword: normalizedKeyword || '热歌',
          nextPage,
          categoryId,
          categoryName,
        });

        sendJson(res, {
          success: true,
          music: result.list || [],
          nextPage: result.nextPage || null,
          categoryId: categoryId || null,
          categoryName: categoryName || null,
          keyword: normalizedKeyword || '热歌',
        });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
    });
    return;
  }

  // 404
  res.writeHead(404);
  res.end('Not Found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ 端口 ${PORT} 已被占用，请先关闭之前的服务`);
    console.error(`   运行: lsof -ti:${PORT} | xargs kill -9\n`);
  } else {
    console.error(`\n❌ 启动失败: ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`\n🚀 蚁小二发布工具已启动！`);
  console.log(`📡 访问地址: http://localhost:${PORT}`);
  console.log(`\n按 Ctrl+C 停止服务\n`);
});
