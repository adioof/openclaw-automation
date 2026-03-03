const { chromium } = require('playwright-core');
const fs = require('fs');

const MAX_CHUNK = 3000; // Larger chunks = fewer requests = less rate limiting
const INPUT_PATH = process.argv[2] || '/tmp/pipeline/input.txt';

function chunkText(text) {
  const lines = text.split('\n');
  const chunks = [];
  let current = '';
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      // Code block boundary — flush current prose chunk
      if (current.trim()) {
        chunks.push({ text: current.trim(), humanize: true });
        current = '';
      }
      // Start or continue accumulating code block
      if (!chunks.length || chunks[chunks.length - 1].humanize !== false) {
        chunks.push({ text: line, humanize: false });
      } else {
        chunks[chunks.length - 1].text += '\n' + line;
      }
      continue;
    }

    if (inCodeBlock) {
      // Inside code block — accumulate without humanizing
      if (chunks.length && chunks[chunks.length - 1].humanize === false) {
        chunks[chunks.length - 1].text += '\n' + line;
      } else {
        chunks.push({ text: line, humanize: false });
      }
      continue;
    }

    // Prose: if adding this line exceeds limit, flush
    if (current.length + line.length + 1 > MAX_CHUNK && current.trim()) {
      chunks.push({ text: current.trim(), humanize: true });
      current = '';
    }
    current += line + '\n';
  }
  if (current.trim()) {
    chunks.push({ text: current.trim(), humanize: true });
  }
  return chunks;
}

async function humanizeChunk(page, text, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await page.goto('https://ai-text-humanizer.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(4000);

      const inputTA = page.locator('textarea').first();
      await inputTA.fill(text);

      await page.locator('button', { hasText: /humanize/i }).first().click();

      // Poll for output
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(3000);
        const outputTA = page.locator('textarea').nth(1);
        const val = await outputTA.inputValue().catch(() => '');
        if (val && val.length > 10) return val;
      }
      throw new Error('Timeout waiting for output');
    } catch (e) {
      if (attempt === retries) throw e;
      console.error('Retry', attempt + 1, ':', e.message);
      await page.waitForTimeout(2000);
    }
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const text = fs.readFileSync(INPUT_PATH, 'utf8');
  const chunks = chunkText(text);
  const results = [];

  console.error('Total chunks:', chunks.length);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk.humanize) {
      results.push(chunk.text);
      console.error(`Chunk ${i + 1}/${chunks.length}: code block (passthrough, ${chunk.text.length} chars)`);
    } else {
      console.error(`Chunk ${i + 1}/${chunks.length}: humanizing ${chunk.text.length} chars...`);
      try {
        const humanized = await humanizeChunk(page, chunk.text);
        results.push(humanized);
        console.error(`Chunk ${i + 1} done: ${humanized.length} chars`);
      } catch (e) {
        console.error(`Chunk ${i + 1} FAILED (${e.message}), using original`);
        results.push(chunk.text); // fallback to original text
      }
      if (i < chunks.length - 1) await page.waitForTimeout(3000);
    }
  }

  console.log(JSON.stringify({ humanized: results.join('\n\n'), chunks: chunks.length }));
  await browser.close();
})();
