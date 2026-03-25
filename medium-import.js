const { chromium } = require('playwright-core');
const fs = require('fs');

// Usage: node medium-import.js <devto-url> [options.json]
// options.json: { "draft": true }
// Uses Medium's "Import a story" feature to pull content from a Dev.to URL

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
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();

  // Load saved cookies
  if (fs.existsSync(COOKIES_PATH)) {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
    await context.addCookies(cookies);
    console.error('Loaded saved cookies');
  } else {
    console.log(JSON.stringify({
      error: 'not_authenticated',
      message: 'No saved cookies. Run /medium/auth first to authenticate.'
    }));
    await browser.close();
    return;
  }

  const page = await context.newPage();

  // Go to Medium import page
  await page.goto('https://medium.com/p/import', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  await page.waitForTimeout(3000);

  // Check if we're logged in
  const url = page.url();
  if (url.includes('/m/signin') || url.includes('/login')) {
    console.log(JSON.stringify({
      error: 'not_authenticated',
      message: 'Not logged in to Medium. Run /medium/auth first.',
      currentUrl: url
    }));
    await browser.close();
    return;
  }

  console.error('On import page:', url);

  // Find the URL input field and paste the Dev.to URL
  const urlInput = page.locator('input[type="text"], input[type="url"], input[placeholder*="URL"], input[placeholder*="url"], input[placeholder*="link"], input[placeholder*="paste"]').first();

  try {
    await urlInput.waitFor({ state: 'visible', timeout: 10000 });
    await urlInput.click();
    await urlInput.fill(DEVTO_URL);
    console.error('Filled URL:', DEVTO_URL);
  } catch (e) {
    // Try alternative: look for any visible input
    const inputs = await page.locator('input').all();
    let found = false;
    for (const input of inputs) {
      if (await input.isVisible()) {
        await input.click();
        await input.fill(DEVTO_URL);
        found = true;
        console.error('Filled URL via fallback input');
        break;
      }
    }
    if (!found) {
      // Take screenshot for debugging
      await page.screenshot({ path: '/tmp/pipeline/medium-import-debug.png' });
      console.log(JSON.stringify({
        error: 'input_not_found',
        message: 'Could not find URL input field on import page',
        screenshot: '/tmp/pipeline/medium-import-debug.png',
        pageUrl: page.url()
      }));
      await browser.close();
      return;
    }
  }

  // Click the import button
  const importBtn = page.locator('button:has-text("Import"), button:has-text("import"), input[type="submit"]').first();
  try {
    await importBtn.waitFor({ state: 'visible', timeout: 5000 });
    await importBtn.click();
    console.error('Clicked import button');
  } catch (e) {
    // Try pressing Enter instead
    await page.keyboard.press('Enter');
    console.error('Pressed Enter (import button not found)');
  }

  // Wait for import to complete — Medium redirects to the draft editor
  await page.waitForTimeout(15000);

  const finalUrl = page.url();
  console.error('After import, URL:', finalUrl);

  // Check if we landed on an editor page (draft created)
  const isDraft = finalUrl.includes('/p/') || finalUrl.includes('/edit') || finalUrl.includes('/new-story');
  const isImportPage = finalUrl.includes('/p/import');

  if (isImportPage) {
    // Still on import page — check for error messages
    const errorText = await page.locator('.error, [class*="error"], [class*="Error"]').textContent().catch(() => null);
    await page.screenshot({ path: '/tmp/pipeline/medium-import-result.png' });
    console.log(JSON.stringify({
      error: 'import_failed',
      message: errorText || 'Still on import page after 15s — import may have failed',
      screenshot: '/tmp/pipeline/medium-import-result.png',
      pageUrl: finalUrl
    }));
  } else {
    // Save cookies
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
