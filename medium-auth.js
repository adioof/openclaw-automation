const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

chromium.use(StealthPlugin());

const EMAIL = process.argv[2];
const COOKIES_PATH = '/tmp/pipeline/medium-cookies.json';

if (!EMAIL) {
  console.log(JSON.stringify({ error: 'Email required as first argument' }));
  process.exit(1);
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
  const page = await context.newPage();

  try {
    await page.goto('https://medium.com/m/signin', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(5000);

    const pageText = await page.locator('body').innerText().catch(() => '');
    console.error('Page text:', pageText.substring(0, 500));

    // Check if Cloudflare challenge is still present
    if (pageText.includes('security verification') || pageText.includes('Cloudflare')) {
      // Wait longer for Cloudflare to pass
      console.error('Cloudflare detected, waiting...');
      await page.waitForTimeout(10000);
      const afterWait = await page.locator('body').innerText().catch(() => '');
      if (afterWait.includes('security verification') || afterWait.includes('Cloudflare')) {
        console.log(JSON.stringify({
          error: 'cloudflare_blocked',
          message: 'Cloudflare challenge could not be bypassed. Try cookie-based auth instead.',
          pageText: afterWait.substring(0, 300)
        }));
        await browser.close();
        return;
      }
    }

    // Look for email sign-in option
    const signInWithEmail = page.locator('button:has-text("email"), a:has-text("email"), button:has-text("Sign in with email")').first();
    try {
      await signInWithEmail.waitFor({ state: 'visible', timeout: 10000 });
      await signInWithEmail.click();
      await page.waitForTimeout(3000);
    } catch (e) {
      console.error('No email button found, trying direct input');
    }

    // Fill email
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email"], input[placeholder*="Email"]').first();
    try {
      await emailInput.waitFor({ state: 'visible', timeout: 10000 });
      await emailInput.fill(EMAIL);
      console.error('Filled email');
    } catch (e) {
      // Take debug screenshot
      await page.screenshot({ path: '/tmp/pipeline/medium-auth-debug.png' });
      console.log(JSON.stringify({
        error: 'email_input_not_found',
        message: 'Could not find email input on sign-in page',
        currentUrl: page.url(),
        screenshot: '/tmp/pipeline/medium-auth-debug.png',
        pageText: (await page.locator('body').innerText().catch(() => '')).substring(0, 500)
      }));
      await browser.close();
      return;
    }

    // Submit
    const submitBtn = page.locator('button:has-text("Continue"), button:has-text("Sign in"), button:has-text("Submit"), button[type="submit"]').first();
    try {
      await submitBtn.click();
      await page.waitForTimeout(5000);
    } catch (e) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(5000);
    }

    // Save cookies from this partial state
    const cookies = await context.cookies();
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies));

    console.log(JSON.stringify({
      status: 'magic_link_sent',
      email: EMAIL,
      message: `Check ${EMAIL} for a Medium magic link. Forward the link to /medium/auth/complete to finish authentication.`,
      currentUrl: page.url()
    }));

  } catch (err) {
    await page.screenshot({ path: '/tmp/pipeline/medium-auth-error.png' }).catch(() => {});
    console.log(JSON.stringify({
      error: err.message,
      screenshot: '/tmp/pipeline/medium-auth-error.png'
    }));
  }

  await browser.close();
})();
