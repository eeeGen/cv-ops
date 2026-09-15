import { access } from 'node:fs/promises';

const blocked = (reason, nextAction, details = {}) => ({ status: 'blocked', reason, nextAction, ...details });
const safeError = (error) => ({
  code: typeof error?.code === 'string' ? error.code.slice(0, 80) : 'UNKNOWN',
  message: typeof error?.message === 'string' ? error.message.replace(/[\r\n]/g, ' ').slice(0, 300) : 'Unknown renderer error',
});
const dependency = (status, details) => ({ status, ...details });

async function defaultLoadPlaywright() {
  return import('playwright');
}

/**
 * Renders supplied HTML only through Chromium.  The browser is denied external
 * network access and page JavaScript is disabled before content is assigned, so
 * private resume HTML cannot execute code or alter its own inspection result.
 */
export async function renderHtmlForAts({ htmlBytes, loadPlaywright = defaultLoadPlaywright } = {}) {
  if (!Buffer.isBuffer(htmlBytes) || htmlBytes.length === 0) {
    return blocked('ATS_INPUT_INVALID', '使用已归档的独立定制 HTML 后重试。');
  }
  let playwright;
  try {
    playwright = await loadPlaywright();
    if (!playwright?.chromium) throw Object.assign(new Error('Playwright chromium export is unavailable.'), { code: 'PLAYWRIGHT_CHROMIUM_UNAVAILABLE' });
  } catch (error) {
    return blocked('PLAYWRIGHT_MISSING', '安装已批准的 Playwright 与 Chromium 后重新运行 ATS 门禁。', {
      dependencies: {
        playwright: dependency('blocked', { reason: 'PLAYWRIGHT_MISSING', stage: 'module-load', command: 'node import playwright', error: safeError(error) }),
        chromium: dependency('blocked', { reason: 'CHROMIUM_NOT_PROBED', stage: 'not-reached', command: 'chromium.executablePath' }),
      },
    });
  }
  const playwrightDependency = dependency('ready', {
    stage: 'module-load', command: 'node import playwright',
    version: typeof playwright.version === 'string' ? playwright.version : null,
  });
  let executablePath;
  try {
    executablePath = playwright.chromium.executablePath();
    await access(executablePath);
  } catch (error) {
    return blocked('CHROMIUM_MISSING', '安装已批准的 Chromium 后重新运行 ATS 门禁。', {
      dependencies: {
        playwright: playwrightDependency,
        chromium: dependency('blocked', { reason: 'CHROMIUM_MISSING', stage: 'executable-probe', command: 'chromium.executablePath', error: safeError(error) }),
      },
    });
  }
  let browser;
  let chromiumDependency = dependency('ready', { stage: 'executable-probe', command: executablePath, version: null });
  try {
    browser = await playwright.chromium.launch({ headless: true });
    chromiumDependency = dependency('ready', { stage: 'launch', command: executablePath, version: await browser.version() });
    // Set this before page creation/content assignment. Page.evaluate remains
    // Playwright's trusted automation channel; no document script is enabled.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const url = route.request().url();
      return url.startsWith('data:') || url === 'about:blank' ? route.continue() : route.abort();
    });
    await page.setContent(htmlBytes.toString('utf8'), { waitUntil: 'load' });
    const inspection = await page.evaluate(() => {
      const text = document.body?.innerText ?? '';
      const images = [...document.images];
      const nestedTables = [...document.querySelectorAll('table table')].length;
      const hiddenText = [...document.querySelectorAll('body *')].some((element) => {
        const style = getComputedStyle(element);
        return (style.display === 'none' || style.visibility === 'hidden') && (element.textContent ?? '').trim().length > 0;
      });
      return { text, imageCount: images.length, nestedTables, hiddenText };
    });
    const screenshot = await page.screenshot({ type: 'png', fullPage: true });
    await context.close();
    return {
      status: 'ready', executablePath, inspection, screenshot,
      security: { javaScriptEnabled: false, network: 'blocked' },
      dependencies: { playwright: playwrightDependency, chromium: chromiumDependency },
    };
  } catch (error) {
    const launchFailed = browser === undefined;
    const chromium = launchFailed
      ? dependency('blocked', { reason: 'CHROMIUM_LAUNCH_FAILED', stage: 'launch', command: executablePath, error: safeError(error) })
      : dependency('ready', { ...chromiumDependency, stage: 'render', renderError: safeError(error) });
    return blocked('RENDER_FAILED', '修复定制 HTML 或浏览器环境后重新渲染 ATS 门禁。', {
      stage: launchFailed ? 'launch' : 'render', error: safeError(error),
      dependencies: { playwright: playwrightDependency, chromium },
    });
  } finally {
    await browser?.close().catch(() => {});
  }
}
