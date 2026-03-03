const { chromium } = require('playwright-core');
const fs = require('fs');

// Usage: node medium-publish.js <article.md> <options.json>
// options.json: { "title": "...", "tags": ["tag1", "tag2"], "draft": true }

const ARTICLE_PATH = process.argv[2] || '/tmp/pipeline/article.md';
const OPTIONS_PATH = process.argv[3] || '/tmp/pipeline/publish-options.json';
const COOKIES_PATH = '/tmp/pipeline/medium-cookies.json';

function markdownToMediumBlocks(md) {
  // Medium's editor needs content pasted in. We'll type/paste it section by section.
  // Split by double newline into paragraphs
  const blocks = [];
  const lines = md.split('\n');
  let currentBlock = '';
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        // End code block
        currentBlock += line + '\n';
        blocks.push({ type: 'code', text: currentBlock });
        currentBlock = '';
        inCodeBlock = false;
      } else {
        // Flush any prose
        if (currentBlock.trim()) {
          blocks.push({ type: 'prose', text: currentBlock.trim() });
          currentBlock = '';
        }
        inCodeBlock = true;
        currentBlock = line + '\n';
      }
      continue;
    }

    if (inCodeBlock) {
      currentBlock += line + '\n';
      continue;
    }

    // Empty line = paragraph break
    if (line.trim() === '') {
      if (currentBlock.trim()) {
        blocks.push({ type: 'prose', text: currentBlock.trim() });
        currentBlock = '';
      }
      continue;
    }

    // Headers
    if (line.match(/^#{1,6}\s/)) {
      if (currentBlock.trim()) {
        blocks.push({ type: 'prose', text: currentBlock.trim() });
        currentBlock = '';
      }
      const level = line.match(/^(#+)/)[1].length;
      const text = line.replace(/^#+\s*/, '');
      blocks.push({ type: 'heading', level, text });
      continue;
    }

    // Table rows
    if (line.trim().startsWith('|')) {
      currentBlock += line + '\n';
      continue;
    }

    currentBlock += line + '\n';
  }

  if (currentBlock.trim()) {
    blocks.push({ type: inCodeBlock ? 'code' : 'prose', text: currentBlock.trim() });
  }

  return blocks;
}

(async () => {
  let options = { draft: true, tags: [] };
  try {
    options = { ...options, ...JSON.parse(fs.readFileSync(OPTIONS_PATH, 'utf8')) };
  } catch (e) {
    console.error('No options file, using defaults');
  }

  const article = fs.readFileSync(ARTICLE_PATH, 'utf8');
  
  // Extract title from first H1 if not provided
  if (!options.title) {
    const titleMatch = article.match(/^#\s+(.+)$/m);
    options.title = titleMatch ? titleMatch[1] : 'Untitled';
  }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();

  // Load saved cookies if they exist
  if (fs.existsSync(COOKIES_PATH)) {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
    await context.addCookies(cookies);
    console.error('Loaded saved cookies');
  }

  const page = await context.newPage();

  // Navigate to Medium new story
  await page.goto('https://medium.com/new-story', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // Check if we're logged in
  const url = page.url();
  if (url.includes('/m/signin') || url.includes('/login')) {
    // Not logged in — need to handle auth
    // Try Google login or email-based login
    console.log(JSON.stringify({ 
      error: 'not_authenticated',
      message: 'Not logged in to Medium. Run /medium/auth first to authenticate.',
      currentUrl: url
    }));
    await browser.close();
    return;
  }

  console.error('Logged in, on:', url);

  // Medium's new editor - find the title field and content area
  // Title is usually the first contenteditable or h3/h4 placeholder
  await page.waitForTimeout(3000);

  // Type title
  const titleField = page.locator('[data-testid="title"], h3[data-placeholder], h4[data-placeholder], [role="textbox"]').first();
  await titleField.click();
  await titleField.fill(options.title);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);

  // Now paste the article body (without the title line)
  const bodyText = article.replace(/^#\s+.+\n*/, '').trim();
  
  // For Medium, we'll paste the markdown content
  // Medium's editor handles some markdown natively
  await page.keyboard.type(bodyText, { delay: 5 });

  await page.waitForTimeout(3000);

  // Add tags if provided
  if (options.tags && options.tags.length > 0) {
    console.error('Adding tags:', options.tags);
    // Tags are added during the publish flow
  }

  if (options.draft) {
    // Just save as draft - Medium auto-saves
    await page.waitForTimeout(5000);
    const draftUrl = page.url();
    console.log(JSON.stringify({ 
      status: 'draft_saved',
      url: draftUrl,
      title: options.title
    }));
  } else {
    // Click publish
    // Find the publish button (usually in top-right)
    const publishBtn = page.locator('button', { hasText: /publish/i }).first();
    await publishBtn.click();
    await page.waitForTimeout(3000);

    // Add tags in the publish dialog
    for (const tag of (options.tags || [])) {
      const tagInput = page.locator('input[placeholder*="tag"], input[placeholder*="topic"]').first();
      await tagInput.fill(tag);
      await page.waitForTimeout(1000);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
    }

    // Confirm publish
    const confirmBtn = page.locator('button', { hasText: /publish/i }).last();
    await confirmBtn.click();
    await page.waitForTimeout(5000);

    const publishedUrl = page.url();
    console.log(JSON.stringify({
      status: 'published',
      url: publishedUrl,
      title: options.title
    }));
  }

  // Save cookies for next time
  const cookies = await context.cookies();
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies));
  console.error('Cookies saved');

  await browser.close();
})();
