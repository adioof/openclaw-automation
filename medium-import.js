const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

chromium.use(StealthPlugin());

const DEVTO_URL = process.argv[2];
const OPTIONS_PATH = process.argv[3];
const COOKIES_PATH = '/tmp/pipeline/medium-cookies.json';

if (!DEVTO_URL) {
  console.log(JSON.stringify({ error: 'devto_url required' }));
  process.exit(1);
}

let options = { draft: true };
if (OPTIONS_PATH && fs.existsSync(OPTIONS_PATH)) {
  try {
    options = { ...options, ...JSON.parse(fs.readFileSync(OPTIONS_PATH, 'utf8')) };
  } catch (e) {}
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  });

  // Load saved cookies
  if (fs.existsSync(COOKIES_PATH)) {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
    await context.addCookies(cookies);
    console.error('Loaded saved cookies');
  } else {
    console.log(JSON.stringify({
      error: 'not_authenticated',
      message: 'No saved cookies. Run /medium/auth first.'
    }));
    await browser.close();
    return;
  }

  const page = await context.newPage();

  // Go to Medium import page
  await page.goto('https://medium.com/p/import', {
    waitUntil: 'networkidle',
    timeout: 60000
  });
  await page.waitForTimeout(5000);

  // Check for Cloudflare
  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (bodyText.includes('security verification') || bodyText.includes('Cloudflare')) {
    console.error('Cloudflare challenge, waiting...');
    await page.waitForTimeout(15000);
  }

  // Check if we're logged in
  const url = page.url();
  if (url.includes('/m/signin') || url.includes('/login')) {
    console.log(JSON.stringify({
      error: 'not_authenticated',
      message: 'Not logged in. Run /medium/auth first.',
      currentUrl: url
    }));
    await browser.close();
    return;
  }

  console.error('On import page:', url);

  // Find the URL input field
  const urlInput = page.locator('input[type="text"], input[type="url"], input[placeholder*="URL"], input[placeholder*="url"], input[placeholder*="link"], input[placeholder*="paste"]').first();

  try {
    await urlInput.waitFor({ state: 'visible', timeout: 15000 });
    await urlInput.click();
    await urlInput.fill(DEVTO_URL);
    console.error('Filled URL:', DEVTO_URL);
  } catch (e) {
    const inputs = await page.locator('input').all();
    let found = false;
    for (const input of inputs) {
      if (await input.isVisible()) {
        await input.click();
        await input.fill(DEVTO_URL);
        found = true;
        console.error('Filled via fallback');
        break;
      }
    }
    if (!found) {
      await page.screenshot({ path: '/tmp/pipeline/medium-import-debug.png' });
      console.log(JSON.stringify({
        error: 'input_not_found',
        message: 'Could not find URL input',
        screenshot: '/tmp/pipeline/medium-import-debug.png',
        pageUrl: page.url(),
        pageText: (await page.locator('body').innerText().catch(() => '')).substring(0, 500)
      }));
      await browser.close();
      return;
    }
  }

  // Click import button
  const importBtn = page.locator('button:has-text("Import"), button:has-text("import"), input[type="submit"]').first();
  try {
    await importBtn.waitFor({ state: 'visible', timeout: 5000 });
    await importBtn.click();
    console.error('Clicked import');
  } catch (e) {
    await page.keyboard.press('Enter');
    console.error('Pressed Enter');
  }

  // Wait for import to complete
  await page.waitForTimeout(20000);

  const finalUrl = page.url();
  console.error('After import:', finalUrl);

  const isImportPage = finalUrl.includes('/p/import');

  if (isImportPage) {
    await page.screenshot({ path: '/tmp/pipeline/medium-import-result.png' });
    const errorText = await page.locator('.error, [class*="error"], [class*="Error"]').textContent().catch(() => null);
    const pageContent = await page.locator('body').innerText().catch(() => '');
    console.log(JSON.stringify({
      error: 'import_may_have_failed',
      message: errorText || 'Still on import page after 20s',
      screenshot: '/tmp/pipeline/medium-import-result.png',
      pageText: pageContent.substring(0, 500)
    }));
  } else {
    const cookies = await context.cookies();
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies));

    console.log(JSON.stringify({
      status: 'imported',
      url: finalUrl,
      source: DEVTO_URL,
      draft: true,
      message: 'Article imported as draft. Canonical URL set to original Dev.to post.'
    }));
  }

  await browser.close();
})();
