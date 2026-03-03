const { chromium } = require('playwright-core');
const fs = require('fs');

// Medium authentication via email magic link
// Usage: node medium-auth.js <email>
// Returns a URL for the user to complete login, then saves cookies

const EMAIL = process.argv[2];
const COOKIES_PATH = '/tmp/pipeline/medium-cookies.json';

if (!EMAIL) {
  console.log(JSON.stringify({ error: 'Email required as first argument' }));
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://medium.com/m/signin', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // Look for email sign-in option
  const emailBtn = page.locator('button', { hasText: /email/i }).first();
  await emailBtn.click().catch(() => {});
  await page.waitForTimeout(2000);

  // Fill email
  const emailInput = page.locator('input[type="email"], input[placeholder*="email"]').first();
  await emailInput.fill(EMAIL);

  // Submit
  const continueBtn = page.locator('button', { hasText: /continue|sign in|submit/i }).first();
  await continueBtn.click();
  await page.waitForTimeout(3000);

  console.log(JSON.stringify({
    status: 'magic_link_sent',
    email: EMAIL,
    message: `Magic link sent to ${EMAIL}. Use /medium/auth/complete with the link from your email to finish authentication.`,
    currentUrl: page.url()
  }));

  // Save partial state
  const cookies = await context.cookies();
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies));

  await browser.close();
})();
