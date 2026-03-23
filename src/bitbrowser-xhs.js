const { chromium } = require('playwright-core');
const fs = require('fs');
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

  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 120000 });
  } catch (error) {
    if (!String(error?.message || '').includes('Frame has been detached')) {
      throw error;
    }
    await wait(1500);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  }
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
    'input.d-input__inner',
    'input[placeholder*="标题"]',
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

function splitImageBatches(imagePaths) {
  const maxFilesPerBatch = 10;
  const maxBatchBytes = 28 * 1024 * 1024;
  const batches = [];
  let currentBatch = [];
  let currentBytes = 0;

  for (const imagePath of imagePaths) {
    const fileSize = fs.statSync(imagePath).size;
    const nextWouldOverflow = currentBatch.length >= maxFilesPerBatch || (currentBatch.length > 0 && currentBytes + fileSize > maxBatchBytes);
    if (nextWouldOverflow) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }
    currentBatch.push(imagePath);
    currentBytes += fileSize;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const element = page.locator(selector).first();
    if (await element.isVisible().catch(() => false)) {
      try {
        await element.click({ timeout: 3000 });
        return true;
      } catch (error) {
        try {
          await element.click({ force: true, timeout: 3000 });
          return true;
        } catch (forceError) {
          try {
            const clicked = await element.evaluate(node => {
              if (!(node instanceof HTMLElement)) return false;
              node.click();
              return true;
            }).catch(() => false);
            if (clicked) return true;
          } catch (evaluateError) {
            // try next selector
          }
        }
      }
    }
  }
  return false;
}

async function clickUploadEntryByText(page, text) {
  const clicked = await page.evaluate((label) => {
    const candidates = Array.from(document.querySelectorAll('span, div, button, a'));
    const target = candidates.find(node => node.textContent?.trim() === label);
    if (!target) return false;

    const clickable = target.closest('button, a, [role="button"], .upload, .creator-tab, .drag-over-upload, .upload-content, .upload-wrapper, .d-tabs__item, .d-grid-item');
    const element = clickable || target;
    if (!(element instanceof HTMLElement)) return false;
    element.click();
    return true;
  }, text).catch(() => false);

  if (clicked) {
    await wait(1200);
    return true;
  }

  return false;
}

async function openImageUploadEntry(page) {
  if (page.url().includes('target=image')) {
    const directImageInput = page.locator('input.upload-input[type="file"][accept*=".jpg"]').first();
    if (await directImageInput.count().catch(() => 0)) {
      return;
    }
    return;
  }

  const uploadButtonSelectors = [
    'button:has-text("上传图片")',
    'button:has-text("上传图文")',
    'button:has-text("图文笔记")',
    'text=上传图片',
    'text=上传图文',
    'text=图文笔记',
  ];

  const uploadButtonClicked = await clickFirstVisible(page, uploadButtonSelectors);
  if (uploadButtonClicked || await clickUploadEntryByText(page, '上传图片') || await clickUploadEntryByText(page, '上传图文') || await clickUploadEntryByText(page, '图文笔记')) {
    await wait(1200);
    return;
  }

  const clicked = await clickFirstVisible(page, [
    '[target="image"]',
    '.creator-tab',
    '.d-tabs__item',
  ]);
  if (clicked) {
    await wait(1200);
  }
}

async function findUploadInput(page, { requireMultiple = false } = {}) {
  const preferredSelectors = [
    'input.upload-input[type="file"][accept*=".jpg"]',
    'input.upload-input[type="file"][accept*=".jpeg"]',
    'input.upload-input[type="file"][accept*=".png"]',
    'input.upload-input[type="file"][accept*=".webp"]',
  ];

  for (const selector of preferredSelectors) {
    const input = page.locator(selector).first();
    const attached = await input.evaluate(node => node.isConnected).catch(() => false);
    if (!attached) continue;
    const multiple = await input.evaluate(node => node.hasAttribute('multiple')).catch(() => false);
    if (requireMultiple && !multiple) continue;
    return { input, multiple };
  }

  const inputs = page.locator('input[type="file"]');
  const count = await inputs.count();
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    const attached = await input.evaluate(node => node.isConnected).catch(() => false);
    if (!attached) continue;
    const accept = await input.evaluate(node => (node.getAttribute('accept') || '').toLowerCase()).catch(() => '');
    const multiple = await input.evaluate(node => node.hasAttribute('multiple')).catch(() => false);
    const looksLikeVideoOnly = accept && !/png|jpe?g|webp|bmp|gif|image/.test(accept) && /mp4|mov|flv|mkv|ts|mpeg|video/.test(accept);
    if (looksLikeVideoOnly) continue;
    if (requireMultiple && !multiple) continue;
    return { input, multiple };
  }
  return null;
}

async function uploadFilesThroughSingleInput(input, batch, uploadedCount, page) {
  for (let index = 0; index < batch.length; index += 1) {
    await input.setInputFiles(batch[index]);
    await waitForUploadProgress(page, uploadedCount + index + 1);
    await wait(800);
  }
}

async function waitForUploadProgress(page, expectedCount) {
  const reachedExpectedCount = await page.waitForFunction(
    expected => {
      const count = selector => document.querySelectorAll(selector).length;
      const thumbnailCount = Math.max(
        count('.img-list .img-container'),
        count('.img-upload-area .img-container'),
        count('.img-preview-area .img-container'),
        count('.img-list .format-img'),
        count('.img-list .img-idx'),
        count('.img-list img.img.preview'),
        count('.img-container .format-img img')
      );

      const bodyText = (document.body?.innerText || '').replace(/\s+/g, '');
      const ratioMatches = Array.from(bodyText.matchAll(/(\d+)\/(\d+)/g)).map(match => ({
        current: Number(match[1]),
        total: Number(match[2]),
      }));
      const ratioSatisfied = ratioMatches.some(({ current, total }) => current >= expected || total >= expected);
      const pending = /上传中|处理中|解析中|正在上传/.test(bodyText);

      return thumbnailCount >= expected || (ratioSatisfied && !pending);
    },
    expectedCount,
    { timeout: 15000, polling: 250 }
  ).then(() => true).catch(() => false);

  const finalThumbnailReady = await page.waitForFunction(
    expected => {
      const count = selector => document.querySelectorAll(selector).length;
      const thumbnailCount = Math.max(
        count('.img-list .img-container'),
        count('.img-upload-area .img-container'),
        count('.img-preview-area .img-container'),
        count('.img-list .img-idx')
      );
      return thumbnailCount >= expected;
    },
    expectedCount,
    { timeout: reachedExpectedCount ? 3000 : 8000, polling: 250 }
  ).then(() => true).catch(() => false);

  if (!reachedExpectedCount && !finalThumbnailReady) {
    throw new Error(`图片上传未完成，期望 ${expectedCount} 张素材已就绪`);
  }

  await wait(500);
}

async function uploadSingleBatch(page, batch, uploadedCount, batchIndex) {
  const requireMultiple = batch.length > 1;
  const uploadInputInfo = await findUploadInput(page, { requireMultiple });

  if (uploadInputInfo) {
    if (uploadInputInfo.multiple) {
      await uploadInputInfo.input.setInputFiles(batch);
      await waitForUploadProgress(page, uploadedCount + batch.length);
    } else {
      await uploadFilesThroughSingleInput(uploadInputInfo.input, batch, uploadedCount, page);
    }
    return;
  }

  const triggerSelectors = batchIndex === 0
    ? [
        'button.upload-button.bg-red',
        'button.upload-button:has-text("上传图片")',
        'button:has-text("上传图片")',
        'text=上传图文',
        'button:has-text("上传图文")',
        'button:has-text("选择图片")',
        '.drag-over',
      ]
    : [
        'button.upload-button:has-text("上传图片")',
        'button:has-text("上传图片")',
        'text=补充上传',
        'button:has-text("补充上传")',
        'button:has-text("继续上传")',
        'button:has-text("添加图片")',
        'button:has-text("上传图片")',
      ];

  for (const selector of triggerSelectors) {
    const trigger = page.locator(selector).first();
    if (!(await trigger.isVisible().catch(() => false))) continue;

    try {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 2500 }),
        trigger.click({ force: true }),
      ]);

      await chooser.setFiles(batch);
      await waitForUploadProgress(page, uploadedCount + batch.length);
      return;
    } catch (error) {
      const fallbackInputInfo = await findUploadInput(page);
      if (fallbackInputInfo) {
        if (fallbackInputInfo.multiple) {
          await fallbackInputInfo.input.setInputFiles(batch);
          await waitForUploadProgress(page, uploadedCount + batch.length);
        } else {
          await uploadFilesThroughSingleInput(fallbackInputInfo.input, batch, uploadedCount, page);
        }
        return;
      }

      const clickedByText = await clickUploadEntryByText(page, batchIndex === 0 ? '上传图片' : '补充上传');
      if (clickedByText) {
        const retryInputInfo = await findUploadInput(page);
        if (retryInputInfo) {
          if (retryInputInfo.multiple) {
            await retryInputInfo.input.setInputFiles(batch);
            await waitForUploadProgress(page, uploadedCount + batch.length);
          } else {
            await uploadFilesThroughSingleInput(retryInputInfo.input, batch, uploadedCount, page);
          }
          return;
        }
      }
    }
  }

  throw new Error('未找到小红书图片上传入口');
}

async function uploadImages(page, imagePaths) {
  if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
    throw new Error('比特浏览器发布小红书时未找到可上传图片');
  }

  await openImageUploadEntry(page);

  const batches = splitImageBatches(imagePaths);
  let uploadedCount = 0;
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    await uploadSingleBatch(page, batch, uploadedCount, index);
    uploadedCount += batch.length;
    await wait(1200);
  }
}

async function addTags(page, tags) {
  if (!Array.isArray(tags) || tags.length === 0) return;

  const editor = page.locator('.tiptap.ProseMirror[contenteditable="true"]').first();
  await editor.waitFor({ state: 'visible', timeout: 10000 });

  for (const tag of tags) {
    const topicButton = page.locator(
      'button.contentBtn.topic-btn, button:has-text("话题"), .topic-btn'
    ).first();
    if (!(await topicButton.isVisible().catch(() => false))) {
      throw new Error('未找到小红书话题标签入口，无法保证标签已添加');
    }

    const safeTag = String(tag || '').replace(/^#+/, '').trim();
    if (!safeTag) continue;

    const previousText = await editor.textContent().catch(() => '');
    await topicButton.click();
    await page.waitForFunction(
      previous => {
        const editor = document.querySelector('.tiptap.ProseMirror');
        if (!(editor instanceof HTMLElement)) return false;
        const text = editor.textContent || '';
        return document.activeElement === editor && (text.endsWith('#') || text.length > previous.length);
      },
      previousText || '',
      { timeout: 5000 }
    ).catch(() => {});

    await page.keyboard.type(safeTag, { delay: 50 });
    await wait(800);
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      expectedTag => {
        const editor = document.querySelector('.tiptap.ProseMirror');
        const text = editor?.textContent || '';
        return text.includes(expectedTag) && text.includes('[话题]');
      },
      safeTag,
      { timeout: 5000 }
    ).catch(() => {});
    await wait(900);
  }
}

async function scrollToBottom(page) {
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
  await wait(1000);
}

async function waitForUploadComplete(page) {
  const completionSignals = [
    page.locator('text=图文解析完成').first(),
    page.locator('text=上传完成').first(),
  ];

  for (const signal of completionSignals) {
    if (await signal.isVisible().catch(() => false)) {
      return;
    }
  }

  const pendingIndicators = [
    'text=上传中',
    'text=处理中',
    'text=解析中',
  ];

  for (const selector of pendingIndicators) {
    const indicator = page.locator(selector).first();
    if (await indicator.isVisible().catch(() => false)) {
      await indicator.waitFor({ state: 'hidden', timeout: 60000 }).catch(() => {});
      return;
    }
  }

  await wait(2000);
}

async function submitNote(page) {
  const buttonSelectors = [
    'button:has-text("发布笔记")',
    'button:has-text("立即发布")',
    'button:has-text("发布")',
  ];

  let submitButton = null;
  for (const selector of buttonSelectors) {
    const candidate = page.locator(selector).last();
    if (await candidate.isVisible().catch(() => false)) {
      submitButton = candidate;
      break;
    }
  }

  if (!submitButton) {
    throw new Error('未找到小红书发布按钮');
  }

  await submitButton.click();
  const successIndicators = [
    page.waitForURL(url => !url.toString().includes('/publish/publish'), { timeout: 20000 }),
    page.locator('.success-container:has-text("发布成功")').first().waitFor({ state: 'visible', timeout: 20000 }),
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
    await scrollToBottom(page);
    await waitForUploadComplete(page);
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
