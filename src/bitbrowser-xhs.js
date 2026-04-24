const { chromium } = require('playwright-core');
const fs = require('fs');
const bitbrowser = require('./bitbrowser.js');

const XHS_PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish';
const VIDEO_FILE_RE = /\.(mp4|mov|m4v|avi|wmv|flv|mkv|webm|mpeg|mpg|ts|m2ts|rmvb)$/i;

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanPause(min = 120, max = 260) {
  await wait(randomBetween(min, max));
}

async function humanClick(page, locator, options = {}) {
  const timeout = options.timeout || 5000;
  await locator.waitFor({ state: 'visible', timeout });
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await humanPause(80, 180);

  const box = await locator.boundingBox().catch(() => null);
  if (box) {
    const x = box.x + box.width * (0.3 + Math.random() * 0.4);
    const y = box.y + box.height * (0.3 + Math.random() * 0.4);
    await page.mouse.move(x, y, { steps: randomBetween(8, 18) });
    await humanPause(40, 120);
    await page.mouse.down();
    await humanPause(35, 95);
    await page.mouse.up();
  } else {
    await locator.click({ timeout });
  }

  await humanPause(120, 260);
}

async function humanClear(page) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await humanPause(40, 100);
  await page.keyboard.press('Backspace');
  await humanPause(80, 160);
}

async function humanType(page, text, options = {}) {
  const content = String(text || '');
  const baseMin = options.minDelay || 45;
  const baseMax = options.maxDelay || 110;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    await page.keyboard.type(char, { delay: randomBetween(baseMin, baseMax) });

    if (/\s/.test(char)) {
      await humanPause(40, 120);
      continue;
    }

    if (/[，。！？、；：,.!?]/.test(char)) {
      await humanPause(160, 320);
      continue;
    }

    if ((index + 1) % randomBetween(5, 9) === 0) {
      await humanPause(90, 220);
    }
  }
}

async function humanTypeParagraphs(page, text, options = {}) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return;

  for (let index = 0; index < lines.length; index += 1) {
    await humanType(page, lines[index], options);
    if (index < lines.length - 1) {
      await page.keyboard.press('Enter');
      await humanPause(160, 320);
    }
  }
}

async function resolvePublishPage(browser, targetUrl) {
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error('比特浏览器未返回可用上下文');
  }

  const context = contexts[0];
  const existingPages = context.pages().filter(page => !page.isClosed());
  const page = existingPages[0] || await context.newPage();

  for (const extraPage of existingPages.slice(1)) {
    try {
      await extraPage.close();
    } catch (_) {
      // ignore
    }
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

function resolvePublishUrl(baseUrl, target) {
  const nextTarget = target === 'video' ? 'video' : 'image';
  const url = new URL(baseUrl || XHS_PUBLISH_URL);
  url.searchParams.set('from', 'tab_switch');
  url.searchParams.set('target', nextTarget);
  return url.toString();
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
  const targetTitle = String(title || '').trim();
  const selectors = [
    // 视频发布页标题 input（常见 placeholder）
    'input[placeholder="填写标题会有更多赞哦"]',
    'input[placeholder="填写视频标题"]',
    'input[placeholder*="视频标题"]',
    // 图文发布页标题 input
    'input.d-input__inner',
    'input[placeholder*="标题"]',
    'textarea[placeholder*="标题"]',
    // contenteditable 标题（部分页面用 div 实现）
    '[contenteditable="true"][data-placeholder*="标题"]',
    '[contenteditable="true"][placeholder*="标题"]',
  ];

  for (const selector of selectors) {
    const input = page.locator(selector).first();
    if (await input.isVisible().catch(() => false)) {
      await humanClick(page, input);
      await humanClear(page);
      if (targetTitle) {
        await humanType(page, targetTitle, { minDelay: 55, maxDelay: 130 });
      }
      const typedSuccessfully = await page.waitForFunction(
        expected => {
          const input = document.querySelector('input[placeholder="填写标题会有更多赞哦"], input.d-input__inner, input[placeholder*="标题"], textarea[placeholder*="标题"]');
          if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return false;
          return input.value.trim() === expected;
        },
        targetTitle,
        { timeout: 3000, polling: 150 }
      ).then(() => true).catch(() => false);

      if (!typedSuccessfully) {
        await input.evaluate((node, value) => {
          if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) return;
          node.focus();
          node.value = value;
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
          node.blur();
        }, targetTitle).catch(() => {});
      }
      return;
    }
  }

  const placeholderTargets = [
    'text=填写标题会有更多赞哦',
    'text=填写标题',
  ];

  for (const target of placeholderTargets) {
    const placeholder = page.locator(target).first();
    if (!(await placeholder.isVisible().catch(() => false))) continue;

    await humanClick(page, placeholder).catch(() => {});
    await humanPause(180, 360);
    if (targetTitle) {
      await humanClear(page).catch(() => {});
      await humanType(page, targetTitle, { minDelay: 55, maxDelay: 130 });
    }
    return;
  }

  // 最终兜底：JS 直接扫描页面所有可见 input/contenteditable，找最大的标题区域
  const injected = await page.evaluate((value) => {
    // 尝试找到视频标题 input（通常 maxlength 较小，如 20~100）
    const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
    const titleInput = inputs.find(el => {
      if (el.offsetWidth === 0) return false;
      const ph = (el.getAttribute('placeholder') || '').toLowerCase();
      return ph.includes('标题') || ph.includes('title');
    });
    if (titleInput) {
      titleInput.focus();
      titleInput.value = value;
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      titleInput.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    // 尝试找 contenteditable 标题容器（排除正文大区域）
    const editors = Array.from(document.querySelectorAll('[contenteditable="true"]'));
    const small = editors.find(el => {
      const rect = el.getBoundingClientRect();
      return rect.height > 0 && rect.height < 80 && rect.width > 200;
    });
    if (small) {
      small.focus();
      small.textContent = value;
      small.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    return false;
  }, targetTitle).catch(() => false);

  if (injected) return;

  throw new Error('未找到小红书标题输入框');
}

async function fillDescription(page, description) {
  const targetDescription = String(description || '').trim();
  const editorSelectors = [
    '.note-content .tiptap.ProseMirror[contenteditable="true"]',
    '.note-content [contenteditable="true"]',
    '.d-textarea [contenteditable="true"]',
    '.tiptap.ProseMirror[contenteditable="true"]',
    '[contenteditable="true"]',
    '.ql-editor',
    '[data-placeholder*="正文"]',
    'textarea[placeholder*="正文"]',
  ];

  for (const selector of editorSelectors) {
    const editor = page.locator(selector).first();
    if (await editor.isVisible().catch(() => false)) {
      await humanClick(page, editor);
      await humanClear(page);
      if (targetDescription) {
        await humanTypeParagraphs(page, targetDescription, { minDelay: 35, maxDelay: 95 });
      }
      const normalizedExpected = targetDescription.replace(/\s+/g, '');
      const typedSuccessfully = await page.waitForFunction(
        expected => {
          const editor = document.querySelector('.tiptap.ProseMirror[contenteditable="true"], [contenteditable="true"], .ql-editor, [data-placeholder*="正文"], textarea[placeholder*="正文"]');
          if (!editor) return false;
          if (editor instanceof HTMLTextAreaElement) {
            return editor.value.replace(/\s+/g, '').includes(expected);
          }
          const text = (editor.textContent || '').replace(/\s+/g, '');
          return expected ? text.includes(expected) : true;
        },
        normalizedExpected,
        { timeout: 3000, polling: 150 }
      ).then(() => true).catch(() => false);

      if (!typedSuccessfully && targetDescription) {
        await editor.evaluate((node, value) => {
          if (node instanceof HTMLTextAreaElement) {
            node.focus();
            node.value = value;
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }

          if (!(node instanceof HTMLElement)) return;
          node.focus();
          if (node.classList.contains('ProseMirror') || node.getAttribute('contenteditable') === 'true') {
            const html = value
              .split(/\r?\n/)
              .filter(Boolean)
              .map(line => `<p>${line}</p>`)
              .join('') || '<p></p>';
            node.innerHTML = html;
          } else {
            node.textContent = value;
          }
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        }, targetDescription).catch(() => {});
      }
      await humanPause(220, 420);
      return;
    }
  }

  const placeholderTargets = [
    'text=输入正文描述，真诚有价值的分享予人温暖',
    'text=输入正文描述',
    'text=输入正文',
  ];

  for (const target of placeholderTargets) {
    const placeholder = page.locator(target).first();
    if (!(await placeholder.isVisible().catch(() => false))) continue;

    await humanClick(page, placeholder).catch(() => {});
    await humanPause(200, 420);
    const wrote = await page.evaluate((value) => {
      const candidates = Array.from(document.querySelectorAll('.note-content [contenteditable="true"], .d-textarea [contenteditable="true"], .tiptap.ProseMirror[contenteditable="true"], [contenteditable="true"], textarea[placeholder*="正文"]'))
        .filter(node => {
          if (!(node instanceof HTMLElement || node instanceof HTMLTextAreaElement)) return false;
          const rect = node.getBoundingClientRect();
          return rect.width > 240 && rect.height > 60;
        })
        .sort((a, b) => {
          const rectA = a.getBoundingClientRect();
          const rectB = b.getBoundingClientRect();
          return rectB.height * rectB.width - rectA.height * rectA.width;
        });

      const editor = candidates[0];
      if (!editor) return false;

      if (editor instanceof HTMLTextAreaElement) {
        editor.focus();
        editor.value = value;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }

      if (!(editor instanceof HTMLElement)) return false;
      editor.focus();
      const html = value
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => `<p>${line}</p>`)
        .join('') || '<p></p>';
      editor.innerHTML = html;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, targetDescription).catch(() => false);

    if (!wrote && targetDescription) {
      await humanClear(page).catch(() => {});
      await humanTypeParagraphs(page, targetDescription, { minDelay: 35, maxDelay: 95 });
    }
    return;
  }

  // 最终兜底：JS 直接找最大的 contenteditable 区域注入内容
  const injected = await page.evaluate((value) => {
    // 找面积最大的可见 contenteditable（通常就是正文编辑器）
    const candidates = Array.from(document.querySelectorAll('[contenteditable="true"], textarea'))
      .filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 200 && rect.height > 60 && el.offsetWidth > 0;
      })
      .sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return (rb.width * rb.height) - (ra.width * ra.height);
      });

    const editor = candidates[0];
    if (!editor) return false;

    editor.focus();
    if (editor instanceof HTMLTextAreaElement) {
      editor.value = value;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    const html = value.split(/\r?\n/).filter(Boolean).map(l => `<p>${l}</p>`).join('') || '<p></p>';
    editor.innerHTML = html;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, targetDescription).catch(() => false);

  if (injected) return;

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
  const directImageInput = page.locator(
    'input.upload-input[type="file"][accept*=".jpg"], input.upload-input[type="file"][accept*=".png"], input.upload-input[type="file"][accept*=".jpeg"], input.upload-input[type="file"][accept*=".webp"]'
  ).first();
  if (page.url().includes('target=image') && await directImageInput.evaluate(node => node.isConnected).catch(() => false)) {
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

  await page.waitForFunction(
    () => {
      const href = window.location.href;
      const imageInput = document.querySelector('input.upload-input[type="file"][accept*=".jpg"], input.upload-input[type="file"][accept*=".png"], input.upload-input[type="file"][accept*=".jpeg"], input.upload-input[type="file"][accept*=".webp"]');
      return href.includes('target=image') || !!imageInput;
    },
    { timeout: 8000, polling: 250 }
  ).catch(() => {});
}

async function openVideoUploadEntry(page) {
  const directVideoInput = page.locator('input.upload-input[type="file"][accept*=".mp4"], input.upload-input[type="file"][accept*=".mov"], input.upload-input[type="file"][accept*="video"]').first();
  if (await directVideoInput.isVisible().catch(() => false)) {
    return;
  }

  const textClicked = await clickUploadEntryByText(page, '上传视频');
  if (!textClicked) {
    await clickFirstVisible(page, [
      'button:has-text("上传视频")',
      'text=上传视频',
      '[target="video"]',
    ]);
  }

  await page.waitForFunction(
    () => {
      const href = window.location.href;
      const videoInput = document.querySelector('input.upload-input[type="file"][accept*=".mp4"], input.upload-input[type="file"][accept*=".mov"], input.upload-input[type="file"][accept*="video"]');
      return href.includes('target=video') || !!videoInput;
    },
    { timeout: 10000, polling: 250 }
  ).catch(() => {});
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

async function findVideoUploadInput(page) {
  const preferredSelectors = [
    'input.upload-input[type="file"][accept*=".mp4"]',
    'input.upload-input[type="file"][accept*=".mov"]',
    'input.upload-input[type="file"][accept*="video"]',
  ];

  for (const selector of preferredSelectors) {
    const input = page.locator(selector).first();
    const attached = await input.evaluate(node => node.isConnected).catch(() => false);
    if (!attached) continue;
    return input;
  }

  const inputs = page.locator('input[type="file"]');
  const count = await inputs.count();
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    const attached = await input.evaluate(node => node.isConnected).catch(() => false);
    if (!attached) continue;
    const accept = await input.evaluate(node => (node.getAttribute('accept') || '').toLowerCase()).catch(() => '');
    const looksLikeVideo = /mp4|mov|flv|mkv|ts|mpeg|video/.test(accept);
    if (looksLikeVideo) return input;
  }

  return null;
}

async function findImageOnlyUploadInput(page) {
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
    return input;
  }

  const inputs = page.locator('input[type="file"]');
  const count = await inputs.count();
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    const attached = await input.evaluate(node => node.isConnected).catch(() => false);
    if (!attached) continue;
    const accept = await input.evaluate(node => (node.getAttribute('accept') || '').toLowerCase()).catch(() => '');
    const looksLikeImage = /png|jpe?g|webp|bmp|gif|image/.test(accept);
    const looksLikeVideo = /mp4|mov|flv|mkv|ts|mpeg|video/.test(accept);
    if (looksLikeImage && !looksLikeVideo) return input;
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

async function waitForVideoUploadProgress(page) {
  const uploadReady = await page.waitForFunction(
    () => {
      const bodyText = (document.body?.innerText || '').replace(/\s+/g, '');
      const pending = /上传中|处理中|解析中|正在上传|转码中/.test(bodyText);
      const titleInput = document.querySelector('input[placeholder="填写标题会有更多赞哦"], input[placeholder*="标题"], textarea[placeholder*="标题"]');
      return !!titleInput && !pending;
    },
    { timeout: 90000, polling: 400 }
  ).then(() => true).catch(() => false);

  if (!uploadReady) {
    throw new Error('视频上传未完成或页面未进入可编辑状态');
  }

  await wait(800);
}

async function uploadVideo(page, videoPath) {
  if (!videoPath || !VIDEO_FILE_RE.test(videoPath)) {
    throw new Error('未找到可用于小红书视频发布的视频文件');
  }

  await openVideoUploadEntry(page);

  const videoInput = await findVideoUploadInput(page);
  if (videoInput) {
    await videoInput.setInputFiles(videoPath);
    await waitForVideoUploadProgress(page);
    return;
  }

  const triggerSelectors = [
    'button:has-text("上传视频")',
    'text=上传视频',
    'button.upload-button',
    '.drag-over',
  ];

  for (const selector of triggerSelectors) {
    const trigger = page.locator(selector).first();
    if (!(await trigger.isVisible().catch(() => false))) continue;

    try {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 3000 }),
        trigger.click({ force: true }),
      ]);
      await chooser.setFiles(videoPath);
      await waitForVideoUploadProgress(page);
      return;
    } catch (error) {
      const retryInput = await findVideoUploadInput(page);
      if (retryInput) {
        await retryInput.setInputFiles(videoPath);
        await waitForVideoUploadProgress(page);
        return;
      }
    }
  }

  throw new Error('未找到小红书视频上传入口');
}

// 等待封面上传完成
// beforeCount：上传前弹窗内的缩略图数量，新缩略图出现即代表上传成功
async function waitForCoverUpload(page, beforeCount) {
  // 封面弹窗里偶尔会出现“封面上传失败”的 toast，但实际封面已经完成替换。
  // 因此这里不再把 toast 当作失败信号，只关注真实上传态和弹窗内容变化。
  await page.waitForFunction(
    (count) => {
      const cancelBtn = Array.from(document.querySelectorAll('button'))
        .find(btn => (btn.textContent || '').trim() === '取消' && btn.offsetWidth > 0);
      if (!cancelBtn) return true; // 弹窗已关闭

      let container = cancelBtn;
      for (let i = 0; i < 10; i++) {
        if (!container.parentElement) break;
        container = container.parentElement;
        const rect = container.getBoundingClientRect();
        if (rect.width > 500 && rect.height > 400) break;
      }

      // 信号1：弹窗内可见缩略图数量增加（新封面缩略图已渲染）
      const current = Array.from(container.querySelectorAll('img'))
        .filter(img => img.offsetWidth > 0).length;
      if (count > 0 && current > count) return true;

      // 信号2：上传态已结束
      const text = (container.textContent || '').replace(/\s+/g, '');
      const pending = /上传中|处理中|加载中/.test(text);
      if (pending) return false;
      return true;
    },
    beforeCount || 0,
    { timeout: 12000, polling: 300 }
  ).catch(() => {});
  await wait(randomBetween(500, 900));
}

async function scrollToCoverSection(page) {
  await page.evaluate(() => {
    const keywords = ['封面', '编辑封面', '上传封面', '更换封面', '设置封面', '选择封面', '修改封面', '自定义封面'];
    const candidates = Array.from(document.querySelectorAll('button, span, div, a'))
      .filter(node => keywords.some(keyword => node.textContent?.includes(keyword)));

    if (candidates.length > 0) {
      const target = candidates[0];
      if (target instanceof HTMLElement) {
        target.scrollIntoView({ block: 'center', behavior: 'auto' });
        return;
      }
    }

    window.scrollTo({ top: document.body.scrollHeight * 0.6, behavior: 'auto' });
  }).catch(() => {});
  await wait(600);
}

async function findPrimaryCoverCard(page) {
  const handle = await page.evaluateHandle(() => {
    const nodes = Array.from(document.querySelectorAll('div, section'));
    const section = nodes.find(node => node.textContent?.includes('设置封面'));
    if (!section) return null;

    const container = section.closest('div')?.parentElement || section;
    const cards = Array.from(container.querySelectorAll('div, button'))
      .filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.width > 120 && rect.height > 120 && !!node.querySelector('img, canvas, video');
      })
      .sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        return rectA.left - rectB.left || rectA.top - rectB.top;
      });

    return cards[0] || null;
  }).catch(() => null);

  const element = handle?.asElement?.() || null;
  if (!element) {
    await handle?.dispose?.().catch(() => {});
    return null;
  }
  return element;
}

async function openVideoCoverDialog(page) {
  const confirmButton = page.locator('button:has-text("确定")').last();
  if (await confirmButton.isVisible().catch(() => false)) {
    return;
  }

  await scrollToCoverSection(page);

  const primaryCard = await findPrimaryCoverCard(page);
  if (primaryCard) {
    try {
      await primaryCard.scrollIntoViewIfNeeded();
      const box = await primaryCard.boundingBox();
      if (box) {
        await page.mouse.move(
          box.x + box.width * 0.5,
          box.y + box.height * 0.5,
          { steps: randomBetween(10, 20) }
        );
        await humanPause(500, 900);
      }
    } catch (_) {
      // ignore and try text/button fallbacks below
    }
  }

  const modifySelectors = [
    'button:has-text("修改封面")',
    'text=修改封面',
    'button:has-text("编辑封面")',
    'text=编辑封面',
  ];

  const clickedModify = await clickFirstVisible(page, modifySelectors);
  if (!clickedModify) {
    await clickUploadEntryByText(page, '修改封面').catch(() => false);
    await clickUploadEntryByText(page, '编辑封面').catch(() => false);
  }

  await page.waitForFunction(
    () => {
      const bodyText = document.body?.innerText || '';
      const hasModalTitle = bodyText.includes('设置封面');
      const hasConfirm = Array.from(document.querySelectorAll('button')).some(button => button.textContent?.includes('确定'));
      return hasModalTitle && hasConfirm;
    },
    { timeout: 8000, polling: 250 }
  ).catch(() => {});
}

// 获取弹窗内当前可见缩略图数量
async function getCoverThumbCount(page) {
  return page.evaluate(() => {
    const cancelBtn = Array.from(document.querySelectorAll('button'))
      .find(btn => (btn.textContent || '').trim() === '取消' && btn.offsetWidth > 0);
    if (!cancelBtn) return 0;
    let container = cancelBtn;
    for (let i = 0; i < 10; i++) {
      if (!container.parentElement) break;
      container = container.parentElement;
      const rect = container.getBoundingClientRect();
      if (rect.width > 500 && rect.height > 400) break;
    }
    return Array.from(container.querySelectorAll('img')).filter(img => img.offsetWidth > 0).length;
  }).catch(() => 0);
}

async function getPrimaryVideoCoverSrc(page) {
  return page.evaluate(() => {
    const section = Array.from(document.querySelectorAll('div, section'))
      .find(node => node.textContent?.includes('设置封面'));
    if (!section) return '';

    const scope = section.closest('div')?.parentElement || section;
    const candidates = Array.from(scope.querySelectorAll('img'))
      .filter(img => img instanceof HTMLImageElement && img.offsetWidth > 80 && img.offsetHeight > 80);

    const first = candidates[0];
    return first?.currentSrc || first?.src || '';
  }).catch(() => '');
}

async function getCoverDialogSignature(page) {
  return page.evaluate(() => {
    const cancelBtn = Array.from(document.querySelectorAll('button'))
      .find(btn => (btn.textContent || '').trim() === '取消' && btn.offsetWidth > 0);
    if (!cancelBtn) return '';

    let container = cancelBtn;
    for (let i = 0; i < 10; i++) {
      if (!container.parentElement) break;
      container = container.parentElement;
      const rect = container.getBoundingClientRect();
      if (rect.width > 500 && rect.height > 400) break;
    }

    const imageSig = Array.from(container.querySelectorAll('img'))
      .filter(img => img.offsetWidth > 0 && img.offsetHeight > 0)
      .map(img => {
        const src = img.currentSrc || img.src || '';
        const alt = img.getAttribute('alt') || '';
        return `${src}|${alt}|${img.naturalWidth}x${img.naturalHeight}`;
      })
      .join('||');

    const textSig = (container.textContent || '').replace(/\s+/g, ' ').trim();
    return `${imageSig}###${textSig}`;
  }).catch(() => '');
}

async function waitForCoverDialogReady(page) {
  await page.waitForFunction(
    () => {
      const bodyText = document.body?.innerText || '';
      const hasModalTitle = bodyText.includes('设置封面');
      const hasConfirm = Array.from(document.querySelectorAll('button'))
        .some(button => button.textContent?.includes('确定') && button.offsetWidth > 0);
      const hasUpload = Array.from(document.querySelectorAll('button, span, div'))
        .some(node => (node.textContent || '').trim() === '上传图片' && node instanceof HTMLElement && node.offsetWidth > 0);
      return hasModalTitle && hasConfirm && hasUpload;
    },
    { timeout: 6000, polling: 200 }
  ).catch(() => {});
}

async function uploadVideoCover(page, coverPath) {
  if (!coverPath) return;

  await openVideoCoverDialog(page);
  await waitForCoverDialogReady(page);
  await wait(randomBetween(900, 1400));

  const beforeCount = await getCoverThumbCount(page);
  const beforePrimarySrc = await getPrimaryVideoCoverSrc(page);
  const beforeDialogSignature = await getCoverDialogSignature(page);

  // 必须通过点击"上传图片"按钮触发 filechooser，不能直接 setInputFiles 到隐藏 input
  // 原因：直接 setInputFiles 会绕过 XiaoHongShu 的 React 事件系统，文件附到 DOM 但不会真正上传
  const tryUploadViaChooser = async (clickFn) => {
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 4000 }),
        clickFn(),
      ]);
      await chooser.setFiles(coverPath);
      return true;
    } catch (_) {
      return false;
    }
  };

  const clickUploadBtn = () =>
    page.evaluate(() => {
      const cancelBtn = Array.from(document.querySelectorAll('button'))
        .find(btn => (btn.textContent || '').trim() === '取消' && btn.offsetWidth > 0);
      if (!cancelBtn) return;
      let container = cancelBtn;
      for (let i = 0; i < 10; i++) {
        if (!container.parentElement) break;
        container = container.parentElement;
        const rect = container.getBoundingClientRect();
        if (rect.width > 500 && rect.height > 400) break;
      }
      const el = Array.from(container.querySelectorAll('*'))
        .find(e => e.offsetWidth > 0 && (e.textContent || '').trim() === '上传图片');
      if (el) el.click();
    });

  // 上传重试循环：最多 2 次；注意不要把 toast“封面上传失败”直接当成最终失败，
  // 真实成功信号以封面缩略图/预览变化为准。
  let uploadSuccess = false;
  for (let attempt = 0; attempt < 2 && !uploadSuccess; attempt++) {
    if (attempt > 0) {
      console.log('[XHS] 封面未检测到成功信号，准备重试...');
      await wait(randomBetween(1800, 2600));
    }

    // 优先用 JS 精确定位弹窗内"上传图片"，其次 Playwright locator
    let triggered = await tryUploadViaChooser(clickUploadBtn);
    if (!triggered) {
      triggered = await tryUploadViaChooser(() =>
        page.locator('text=上传图片').last().click({ force: true })
      );
    }
    if (!triggered) {
      // 最后兜底：直接 setInputFiles（注意：React 事件可能不触发，仅作兜底）
      const imageInput = await findImageOnlyUploadInput(page);
      if (imageInput) { await imageInput.setInputFiles(coverPath); triggered = true; }
    }
    if (!triggered) break;

    // 等待上传结果（缩略图变化 / 主封面变化 / 上传态结束）
    await waitForCoverUpload(page, beforeCount);

    // 真实成功判断：缩略图数量增加，或第一张主封面预览 src 变化
    const afterCount = await getCoverThumbCount(page);
    const afterPrimarySrc = await getPrimaryVideoCoverSrc(page);
    const afterDialogSignature = await getCoverDialogSignature(page);
    uploadSuccess =
      afterCount > beforeCount ||
      (!!beforePrimarySrc && !!afterPrimarySrc && afterPrimarySrc !== beforePrimarySrc) ||
      (!!beforeDialogSignature && !!afterDialogSignature && afterDialogSignature !== beforeDialogSignature);

    if (!uploadSuccess && attempt === 0) {
      console.warn('[XHS] 封面首次上传未检测到有效变化，准备重试...');
    }
  }

  if (!uploadSuccess) {
    console.warn('[XHS] 封面未检测到明确成功信号，继续使用当前页面可见封面并尝试确认');
    // 不再重试，直接点确定关闭弹窗，用视频默认帧
  }

  // "取消"按钮只存在于弹窗内，消失即弹窗关闭（主页面没有"取消"按钮）
  const isCancelVisible = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).some(
        btn => (btn.textContent || '').trim() === '取消' && btn.offsetWidth > 0
      )
    ).catch(() => false);

  // 双保险点击"确定"：Playwright force click + JS click
  // 注意：humanClick 用 mouse.down/up，可能被 modal 层静默拦截而不抛错
  const clickConfirm = async () => {
    const trigger = page.locator('button:has-text("确定")').last();
    if (await trigger.isVisible().catch(() => false)) {
      await trigger.click({ force: true }).catch(() => {});
    }
    await wait(300);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')]
        .reverse()
        .find(b => (b.textContent || '').trim().includes('确定') && b.offsetWidth > 0);
      if (btn) btn.click();
    }).catch(() => {});
  };

  // 重试最多 6 次，每次点完短等检查弹窗是否关闭
  let dialogClosed = false;
  for (let attempt = 0; attempt < 6 && !dialogClosed; attempt++) {
    await clickConfirm();
    await wait(900);
    dialogClosed = !(await isCancelVisible());
  }

  // 兜底：等"取消"消失（最长 25s）
  await page.waitForFunction(
    () => !Array.from(document.querySelectorAll('button')).some(
      btn => (btn.textContent || '').trim() === '取消' && btn.offsetWidth > 0
    ),
    { timeout: 25000, polling: 400 }
  ).catch(() => {});

  // 等"发布"按钮可见，确认主页面已恢复
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('button')).some(
      btn => (btn.textContent || '').trim() === '发布' && !btn.hasAttribute('disabled')
    ),
    { timeout: 15000, polling: 400 }
  ).catch(() => {});

  // 最终保险：弹窗仍在就再 JS 点一次
  if (await isCancelVisible()) {
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')]
        .reverse()
        .find(b => (b.textContent || '').trim().includes('确定') && b.offsetWidth > 0);
      if (btn) btn.click();
    }).catch(() => {});
    await wait(3000);
  }
}

async function addTags(page, tags) {
  if (!Array.isArray(tags) || tags.length === 0) return;

  const editor = page.locator('.tiptap.ProseMirror[contenteditable="true"]').first();
  await editor.waitFor({ state: 'visible', timeout: 10000 });

  // 把光标移到编辑器最末尾，确保标签追加在正文后面而非前面
  await page.evaluate(() => {
    const ed = document.querySelector('.tiptap.ProseMirror[contenteditable="true"]');
    if (!ed) return;
    ed.focus();
    const range = document.createRange();
    range.selectNodeContents(ed);
    range.collapse(false);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  }).catch(() => {});
  await page.keyboard.press('Meta+End').catch(() =>
    page.keyboard.press('Control+End').catch(() => {})
  );
  await wait(randomBetween(600, 1000));
  // 标签前换行，避免紧贴正文末尾
  await page.keyboard.press('Enter').catch(() => {});
  await wait(randomBetween(400, 700));

  for (const tag of tags) {
    const topicButton = page.locator(
      'button.contentBtn.topic-btn, button:has-text("话题"), .topic-btn'
    ).first();
    if (!(await topicButton.isVisible().catch(() => false))) {
      throw new Error('未找到小红书话题标签入口，无法保证标签已添加');
    }

    const safeTag = String(tag || '').replace(/^#+/, '').trim();
    if (!safeTag) continue;

    // 每个标签开始前停顿，模拟人类思考下一个要输什么
    await humanPause(800, 1800);

    const previousText = await editor.textContent().catch(() => '');
    await humanClick(page, topicButton);
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

    // 点击话题按钮后稍等再开始输入
    await humanPause(500, 900);
    await humanType(page, safeTag, { minDelay: 80, maxDelay: 160 });
    // 输完后等建议下拉出现（网络有延迟，给足时间）
    await humanPause(1200, 2000);

    const suggestionSelectors = [
      '[role="option"]',
      '.d-select-option',
      '.search-item',
      '.d-grid-item',
      'li',
      'button',
      'div',
      'span',
    ];

    let suggestionClicked = false;
    for (const selector of suggestionSelectors) {
      const items = page.locator(selector);
      const count = await items.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const item = items.nth(i);
        const visible = await item.isVisible().catch(() => false);
        if (!visible) continue;

        const itemText = ((await item.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        const exact =
          itemText === safeTag ||
          itemText === `#${safeTag}` ||
          itemText.startsWith(`${safeTag} `) ||
          itemText.startsWith(`#${safeTag} `) ||
          itemText.startsWith(`${safeTag}\n`) ||
          itemText.startsWith(`#${safeTag}\n`);
        if (!exact) continue;

        const inEditor = await item.evaluate(node => {
          const editor = document.querySelector('.tiptap.ProseMirror');
          return !!(editor && editor.contains(node));
        }).catch(() => false);
        if (inEditor) continue;

        const clicked = await item.evaluate(node => {
          const clickable = node.closest('[role="option"], .d-select-option, .search-item, .d-grid-item, li, button, div');
          const el = clickable || node;
          if (!(el instanceof HTMLElement)) return false;
          el.click();
          return true;
        }).catch(() => false);
        if (clicked) {
          suggestionClicked = true;
          break;
        }
      }
      if (suggestionClicked) break;
    }

    if (suggestionClicked) {
      await humanPause(500, 900);
    } else {
      // 没有精确匹配的话题：先关闭下拉，再选中当前段落整行后删除
      // 不用逐字退格——ProseMirror 里字符数量难以精确计算，容易误删正文
      await page.keyboard.press('Escape').catch(() => {});
      await wait(randomBetween(400, 700));
      // 跳到行首（Mac: Cmd+Left，兜底 Home）
      await page.keyboard.press('Meta+ArrowLeft').catch(() =>
        page.keyboard.press('Home').catch(() => {})
      );
      // Shift + 行尾：选中整行
      await page.keyboard.down('Shift').catch(() => {});
      await page.keyboard.press('Meta+ArrowRight').catch(() =>
        page.keyboard.press('End').catch(() => {})
      );
      await page.keyboard.up('Shift').catch(() => {});
      // 删除选中内容（只删这一段内容，不删换行符）
      await page.keyboard.press('Backspace').catch(() => {});
      await humanPause(500, 1000);
      continue;
    }

    const inserted = await page.waitForFunction(
      expectedTag => {
        const editor = document.querySelector('.tiptap.ProseMirror');
        const text = editor?.textContent || '';
        return text.includes(expectedTag) && text.includes('[话题]');
      },
      safeTag,
      { timeout: 5000 }
    ).then(() => true).catch(() => false);

    if (!inserted) {
      await page.keyboard.press('Escape').catch(() => {});
      await wait(randomBetween(300, 500));
      continue;
    }
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
    const isVideoNote = record.contentType === '视频';
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
    const page = await resolvePublishPage(
      browser,
      resolvePublishUrl(bitbrowserConfig?.publishUrl || XHS_PUBLISH_URL, isVideoNote ? 'video' : 'image')
    );

    await ensureLoggedIn(page);

    onProgress?.({
      stage: 'submitting',
      title: record.title,
      recordId: record.recordId,
      platform: '小红书',
      account: record.xiaohongshuAccount,
      detail: `正在通过比特浏览器上传《${record.title}》${isVideoNote ? '视频' : '图文'}素材`,
    });
    if (isVideoNote) {
      await uploadVideo(page, record.videoPath);
      if (record.coverPath) {
        onProgress?.({
          stage: 'submitting',
          title: record.title,
          recordId: record.recordId,
          platform: '小红书',
          account: record.xiaohongshuAccount,
          detail: `正在设置《${record.title}》的视频封面`,
        });
        await uploadVideoCover(page, record.coverPath);
      }
    } else {
      await uploadImages(page, record.imagePaths || []);
    }
    await humanPause(2000, 4000);
    await fillTitle(page, record.title || '');
    await humanPause(1500, 3000);
    await fillDescription(page, record.description || '');
    await humanPause(2000, 4000);
    await addTags(page, tags || []);
    await scrollToBottom(page);
    await waitForUploadComplete(page);

    // 发布前校验：标题和正文必须在页面上真实可见，不能只依赖某个 input 的 value
    // 因为视频页常会把标题/正文同步进富预览或编辑器，而标准 input/value 读取不稳定。
    const contentCheck = await page.evaluate(() => {
      const visibleText = node => {
        if (!node) return '';
        if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
          return (node.value || '').trim();
        }
        return (node.textContent || '').replace(/\s+/g, ' ').trim();
      };

      const titleCandidates = Array.from(document.querySelectorAll(
        'input[placeholder*="标题"], textarea[placeholder*="标题"], .title, .note-content [contenteditable="true"], [contenteditable="true"]'
      ))
        .filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 180 && rect.height > 20 && el instanceof HTMLElement && el.offsetWidth > 0;
        })
        .map(el => visibleText(el))
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
      const title = titleCandidates[0] || '';

      const bodyCandidates = Array.from(document.querySelectorAll(
        '.tiptap.ProseMirror[contenteditable="true"], .note-content [contenteditable="true"], [data-placeholder*="正文"], textarea, [contenteditable="true"]'
      ))
        .filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 220 && rect.height > 50 && el instanceof HTMLElement && el.offsetWidth > 0;
        })
        .map(el => visibleText(el))
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
      const body = bodyCandidates[0] || '';

      // 视频仍在处理
      const pageText = (document.body?.innerText || '');
      const videoStillProcessing = /视频处理中|视频转码中/.test(pageText);

      return { title, body, videoStillProcessing };
    }).catch(() => ({ title: '', body: '', videoStillProcessing: false }));

    const normalizedPageText = await page.evaluate(() =>
      (document.body?.innerText || '').replace(/\s+/g, '')
    ).catch(() => '');
    const expectedTitle = String(record.title || '').replace(/\s+/g, '');
    const expectedBodySnippet = String(record.description || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean) || '';
    const normalizedBodySnippet = expectedBodySnippet.replace(/\s+/g, '').slice(0, 16);
    const titleVisible = !!contentCheck.title || (!!expectedTitle && normalizedPageText.includes(expectedTitle));
    const bodyVisible = !!contentCheck.body || (!!normalizedBodySnippet && normalizedPageText.includes(normalizedBodySnippet));

    if (contentCheck.videoStillProcessing) {
      throw new Error('发布前校验失败：视频尚未处理完成，已中止发布');
    }
    if (!titleVisible) {
      throw new Error('发布前校验失败：标题为空，已中止发布');
    }
    if (!bodyVisible) {
      throw new Error('发布前校验失败：正文为空，已中止发布');
    }

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
