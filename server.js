const http = require('http');
const { exec, execSync } = require('child_process');
const { writeFileSync, mkdirSync, existsSync } = require('fs');
const { join } = require('path');

const PORT = process.env.PORT || 3000;
const WORK_DIR = '/tmp/pipeline';
const AUTH_DIR = '/tmp/auth';
if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true });
if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });

// Start Xvfb for non-headless browser
try {
  execSync('Xvfb :99 -screen 0 1920x1080x24 &', { stdio: 'pipe' });
  process.env.DISPLAY = ':99';
  console.log('Xvfb started on :99');
} catch (e) {
  console.log('Xvfb setup:', e.message);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

function run(cmd, timeout = 60000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

function jsonRes(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/' || url.pathname === '/health') {
    return jsonRes(res, {
      status: 'ok',
      service: 'tripsy-pipeline',
      endpoints: ['/humanize', '/video/assemble', '/browser/run', '/exec'],
    });
  }

  if (req.method !== 'POST') return jsonRes(res, { error: 'POST only' }, 405);

  try {
    const body = await parseBody(req);

    // Run arbitrary shell command
    if (url.pathname === '/exec') {
      if (!body.command) return jsonRes(res, { error: 'command required' }, 400);
      const result = await run(body.command, body.timeout || 60000);
      return jsonRes(res, { output: result.trim() });
    }

    // Humanize text — writes a Playwright script and runs it
    if (url.pathname === '/humanize') {
      if (!body.text) return jsonRes(res, { error: 'text required' }, 400);

      const inputPath = join(WORK_DIR, 'input.txt');
      const scriptPath = join(WORK_DIR, 'humanize.js');
      writeFileSync(inputPath, body.text);

      writeFileSync(scriptPath, `
        const { chromium } = require('/app/node_modules/playwright-core');
        const fs = require('fs');
        (async () => {
          const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
          const page = await browser.newPage();
          await page.goto('https://www.humanizeai.io/', { waitUntil: 'networkidle', timeout: 30000 });
          const input = fs.readFileSync('${inputPath}', 'utf8');
          await page.locator('textarea').first().fill(input);
          await page.locator('button', { hasText: /humanize/i }).first().click();
          await page.waitForTimeout(20000);
          const output = await page.locator('#outputText').innerText().catch(() => '') || await page.locator('#result').innerText().catch(() => '');
          console.log(JSON.stringify({ humanized: output || 'NO_OUTPUT' }));
          await browser.close();
        })();
      `);

      const result = await run('node ' + scriptPath, 90000);
      try {
        return jsonRes(res, JSON.parse(result.trim()));
      } catch {
        return jsonRes(res, { humanized: result.trim() });
      }
    }

    // Video assembly with ffmpeg
    if (url.pathname === '/video/assemble') {
      const outputPath = join(WORK_DIR, body.outputName || 'output.mp4');

      if (body.clips && body.clips.length > 0) {
        const clipPaths = [];
        for (let i = 0; i < body.clips.length; i++) {
          const p = join(WORK_DIR, 'clip_' + i + '.mp4');
          await run('curl -sL "' + body.clips[i] + '" -o "' + p + '"', 30000);
          clipPaths.push(p);
        }
        const concatFile = join(WORK_DIR, 'concat.txt');
        writeFileSync(concatFile, clipPaths.map(p => "file '" + p + "'").join('\\n'));
        await run('ffmpeg -y -f concat -safe 0 -i "' + concatFile + '" -c copy "' + outputPath + '"', 60000);
      }

      if (body.audio) {
        const audioPath = join(WORK_DIR, 'audio.mp3');
        await run('curl -sL "' + body.audio + '" -o "' + audioPath + '"', 30000);
        const withAudio = join(WORK_DIR, 'with_audio.mp4');
        await run('ffmpeg -y -i "' + outputPath + '" -i "' + audioPath + '" -c:v copy -c:a aac -shortest "' + withAudio + '"', 60000);
        await run('mv "' + withAudio + '" "' + outputPath + '"');
      }

      return jsonRes(res, { status: 'ok', path: outputPath });
    }

    // Generic browser task
    if (url.pathname === '/browser/run') {
      if (!body.commands) return jsonRes(res, { error: 'commands required' }, 400);
      const scriptPath = join(WORK_DIR, 'task.js');
      writeFileSync(scriptPath, `
        const { chromium } = require('/app/node_modules/playwright-core');
        (async () => {
          const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
          const page = await browser.newPage();
          const results = [];
          const commands = ${JSON.stringify(body.commands)};
          for (const cmd of commands) {
            try {
              if (cmd.action === 'goto') await page.goto(cmd.url, { waitUntil: 'networkidle', timeout: 30000 });
              else if (cmd.action === 'fill') await page.fill(cmd.selector, cmd.value);
              else if (cmd.action === 'click') await page.click(cmd.selector);
              else if (cmd.action === 'wait') await page.waitForTimeout(cmd.ms || 2000);
              else if (cmd.action === 'text') results.push(await page.locator(cmd.selector).innerText());
              else if (cmd.action === 'eval') results.push(await page.evaluate(cmd.code));
              results.push({ action: cmd.action, status: 'ok' });
            } catch (e) {
              results.push({ action: cmd.action, error: e.message });
            }
          }
          console.log(JSON.stringify({ results }));
          await browser.close();
        })();
      `);
      const result = await run('node ' + scriptPath, 120000);
      return jsonRes(res, JSON.parse(result.trim()));
    }

    // Auth flow — sign into a service and save session
    if (url.pathname === '/auth/save') {
      if (!body.url || !body.name) return jsonRes(res, { error: 'url and name required' }, 400);
      const statePath = join(AUTH_DIR, body.name + '.json');
      const scriptPath = join(WORK_DIR, 'auth.js');
      writeFileSync(scriptPath, `
        const { chromium } = require('/app/node_modules/playwright-core');
        (async () => {
          const browser = await chromium.launch({
            headless: false,
            args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
          });
          const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 }
          });
          const page = await context.newPage();
          await page.goto('${body.url}', { waitUntil: 'domcontentloaded', timeout: 30000 });

          // Run provided steps
          const steps = ${JSON.stringify(body.steps || [])};
          for (const step of steps) {
            try {
              if (step.action === 'fill') await page.fill(step.selector, step.value);
              else if (step.action === 'click') await page.click(step.selector);
              else if (step.action === 'wait') await page.waitForTimeout(step.ms || 2000);
              else if (step.action === 'type') await page.type(step.selector, step.value, { delay: 50 });
            } catch (e) {
              console.error('Step error:', e.message);
            }
          }

          // Wait for user-specified delay to complete auth
          await page.waitForTimeout(${body.waitMs || 5000});

          // Save storage state
          await context.storageState({ path: '${statePath}' });
          console.log(JSON.stringify({ status: 'ok', saved: '${statePath}' }));
          await browser.close();
        })();
      `);
      const result = await run('node ' + scriptPath, body.timeout || 120000);
      try {
        return jsonRes(res, JSON.parse(result.trim()));
      } catch {
        return jsonRes(res, { output: result.trim() });
      }
    }

    // Check saved auth sessions
    if (url.pathname === '/auth/list') {
      const files = require('fs').readdirSync(AUTH_DIR).filter(f => f.endsWith('.json'));
      return jsonRes(res, { sessions: files.map(f => f.replace('.json', '')) });
    }

    // Publish to Medium using saved auth
    if (url.pathname === '/publish/medium') {
      if (!body.title || !body.content) return jsonRes(res, { error: 'title and content required' }, 400);
      const statePath = join(AUTH_DIR, 'medium.json');
      if (!existsSync(statePath)) return jsonRes(res, { error: 'No Medium auth session. POST /auth/save first with name=medium' }, 400);

      const contentPath = join(WORK_DIR, 'article.txt');
      writeFileSync(contentPath, body.content);
      const scriptPath = join(WORK_DIR, 'publish_medium.js');
      writeFileSync(scriptPath, `
        const { chromium } = require('/app/node_modules/playwright-core');
        const fs = require('fs');
        (async () => {
          const browser = await chromium.launch({
            headless: false,
            args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
          });
          const context = await browser.newContext({
            storageState: '${statePath}',
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 }
          });
          const page = await context.newPage();
          
          // Go to new story
          await page.goto('https://medium.com/new-story', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(5000);
          
          // Check if we're logged in
          const url = page.url();
          if (url.includes('signin') || url.includes('login')) {
            console.log(JSON.stringify({ error: 'Not logged in. Re-auth needed.' }));
            await browser.close();
            return;
          }
          
          const content = fs.readFileSync('${contentPath}', 'utf8');
          const title = ${JSON.stringify(body.title)};
          const tags = ${JSON.stringify(body.tags || [])};
          
          // Type title
          await page.locator('[data-testid="title"], h3[contenteditable], .graf--title, [role="textbox"]').first().click();
          await page.keyboard.type(title, { delay: 20 });
          await page.keyboard.press('Enter');
          await page.keyboard.press('Enter');
          
          // Paste content (Medium supports markdown paste)
          await page.evaluate((text) => {
            const clipboardData = new DataTransfer();
            clipboardData.setData('text/plain', text);
            const event = new ClipboardEvent('paste', { clipboardData, bubbles: true });
            document.activeElement.dispatchEvent(event);
          }, content);
          
          await page.waitForTimeout(3000);
          
          // Save as draft first
          await context.storageState({ path: '${statePath}' });
          
          console.log(JSON.stringify({ status: 'draft_created', url: page.url() }));
          await browser.close();
        })();
      `);
      const result = await run('node ' + scriptPath, 120000);
      try {
        return jsonRes(res, JSON.parse(result.trim()));
      } catch {
        return jsonRes(res, { output: result.trim() });
      }
    }

    return jsonRes(res, { error: 'not found' }, 404);
  } catch (err) {
    console.error('Error:', err);
    return jsonRes(res, { error: err.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log('Pipeline server running on :' + PORT);
});
