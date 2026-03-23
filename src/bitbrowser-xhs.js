const { chromium } = require('playwright-core');
const bitbrowser = require('./bitbrowser.js');

const XHS_PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish';

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function resolvePublishPage(browser, targetUrl) {
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error('比特浏览器未返回可用上下文');
  }

  const context = contexts[0];
  let page = context.pages()[0];
  if (!page) {
    page = await context.newPage();
  }

  await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 120000 });
  return page;
}

async function ensureLoggedIn(page) {
  const loginHints = [
    page.locator('text=登录'),
    page.locator('text=扫码登录'),
    page.locator('text=手机号登录'),
  ];

  for (const hint of loginHints) {
    if (await hint.first().isVisible().catch(() => false)) {
      throw new Error('比特浏览器中的小红书账号未登录，请先在对应 profile 中登录');
    }
  }
}

async function fillTitle(page, title) {
  const selectors = [
    'input[placeholder*="标题"]',
    'input.d-input__inner',
    'textarea[placeholder*="标题"]',
  ];

  for (const selector of selectors) {
    const input = page.locator(selector).first();
    if (await input.isVisible().catch(() => false)) {
      await input.fill(title || '');
      return;
    }
  }

  throw new Error('未找到小红书标题输入框');
}

async function fillDescription(page, description) {
  const editorSelectors = [
    '[contenteditable="true"]',
    '.ql-editor',
    '[data-placeholder*="正文"]',
    'textarea[placeholder*="正文"]',
  ];

  for (const selector of editorSelectors) {
    const editor = page.locator(selector).first();
    if (await editor.isVisible().catch(() => false)) {
      await editor.click();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.press('Backspace');
      if (description) {
        if (selector === 'textarea[placeholder*="正文"]') {
          await editor.fill(description);
        } else {
          await page.keyboard.type(description, { delay: 20 });
        }
      }
      return;
    }
  }

  throw new Error('未找到小红书正文输入区域');
}

async function uploadImages(page, imagePaths) {
  if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
    throw new Error('比特浏览器发布小红书时未找到可上传图片');
  }

  const uploadInput = page.locator('input[type="file"]').first();
  await uploadInput.waitFor({ state: 'attached', timeout: 120000 });
  await uploadInput.setInputFiles(imagePaths);

  // 等待上传完成的粗粒度判断
  await wait(6000);
}

async function addTags(page, tags) {
  if (!Array.isArray(tags) || tags.length === 0) return;

  for (const tag of tags) {
    const topicButton = page.locator('button:has-text("话题"), button:has-text("标签"), .topic-btn, .tag-btn').first();
    if (!(await topicButton.isVisible().catch(() => false))) {
      throw new Error('未找到小红书话题标签入口，无法保证标签已添加');
    }

    await topicButton.click();
    await wait(800);

    const tagInput = page.locator('input[placeholder*="话题"], input[placeholder*="标签"], input[placeholder*="搜索"]').first();
    await tagInput.waitFor({ state: 'visible', timeout: 10000 });
    await tagInput.fill(tag);
    await wait(1000);
    await page.keyboard.press('Enter');
    await wait(800);
  }
}

async function submitNote(page) {
  const submitButton = page.locator('button:has-text("发布"), button:has-text("立即发布")').last();
  if (!(await submitButton.isVisible().catch(() => false))) {
    throw new Error('未找到小红书发布按钮');
  }

  await submitButton.click();
  const successIndicators = [
    page.waitForURL(url => !url.toString().includes('/publish/publish'), { timeout: 20000 }),
    page.locator('text=/发布成功|笔记发布成功|发布完成/').first().waitFor({ state: 'visible', timeout: 20000 }),
  ];

  try {
    await Promise.any(successIndicators);
  } catch (error) {
    throw new Error('点击发布后未检测到成功结果，请检查页面是否仍停留在发布页');
  }
}

async function publishToXiaohongshuViaBitBrowser(record, options = {}) {
  const { browserId, bitbrowserConfig, tags, onProgress } = options;
  let browser;

  try {
    onProgress?.({
      stage: 'submitting',
      title: record.title,
      recordId: record.recordId,
      platform: '小红书',
      account: record.xiaohongshuAccount,
      detail: `正在打开比特浏览器(${record.xiaohongshuAccount})`,
    });

    const browserInfo = await bitbrowser.openBrowser(browserId, bitbrowserConfig);
    browser = await chromium.connectOverCDP(browserInfo.ws);
    const page = await resolvePublishPage(browser, bitbrowserConfig?.publishUrl || XHS_PUBLISH_URL);

    await ensureLoggedIn(page);

    onProgress?.({
      stage: 'submitting',
      title: record.title,
      recordId: record.recordId,
      platform: '小红书',
      account: record.xiaohongshuAccount,
      detail: `正在通过比特浏览器上传《${record.title}》素材`,
    });
    await uploadImages(page, record.imagePaths || []);
    await fillTitle(page, record.title || '');
    await fillDescription(page, record.description || '');
    await addTags(page, tags || []);
    await submitNote(page);

    return {
      success: true,
      publishMode: '比特浏览器发布',
      taskMeta: {
        browserId,
        ws: browserInfo.ws,
      },
    };
  } finally {
    try {
      await browser?.close();
    } catch (e) {
      // ignore
    }
    await bitbrowser.closeBrowser(browserId, bitbrowserConfig);
  }
}

module.exports = {
  publishToXiaohongshuViaBitBrowser,
};
