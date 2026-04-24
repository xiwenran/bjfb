const axios = require('axios');

function getApiBaseUrl(config = {}) {
  return (config.apiBaseUrl || 'http://127.0.0.1:54345').replace(/\/$/, '');
}

function extractErrorMessage(data, fallback) {
  if (!data) return fallback;
  if (typeof data === 'string') return data;
  if (typeof data.msg === 'string') return data.msg;
  if (typeof data.message === 'string') return data.message;
  return fallback;
}

async function openBrowser(browserId, config = {}) {
  if (!browserId) {
    throw new Error('未配置比特浏览器 browserId');
  }

  const apiBaseUrl = getApiBaseUrl(config);
  const response = await axios.post(`${apiBaseUrl}/browser/open`, {
    id: browserId,
    queue: true,
  }, {
    timeout: config.openTimeoutMs || 30000,
  });

  const data = response.data || {};
  if (!data.success || !data.data?.ws) {
    throw new Error(extractErrorMessage(data, '打开比特浏览器失败'));
  }

  return data.data;
}

async function closeBrowser(browserId, config = {}) {
  if (!browserId) return;

  const apiBaseUrl = getApiBaseUrl(config);
  try {
    await axios.post(`${apiBaseUrl}/browser/close`, { id: browserId }, {
      timeout: config.closeTimeoutMs || 15000,
    });
  } catch (error) {
    const message = error?.response?.data ? extractErrorMessage(error.response.data, error.message) : error.message;
    console.warn(`⚠️ 关闭比特浏览器失败: ${message}`);
  }
}

module.exports = {
  getApiBaseUrl,
  openBrowser,
  closeBrowser,
};
