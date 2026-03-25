const http = require('http');
const { exec, execSync } = require('child_process');
const { writeFileSync, mkdirSync, existsSync } = require('fs');
const { join } = require('path');
const { humanize: humanizeText, detectOnly } = require('./humanizer');

const PORT = process.env.PORT || 3000;
const WORK_DIR = '/tmp/pipeline';
if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true });

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
      endpoints: ['/api/v1/humanize', '/api/v1/detect', '/humanize', '/medium/auth', '/medium/auth/complete', '/medium/import', '/medium/publish', '/video/assemble', '/browser/run', '/exec'],
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

    // ============================================================
    // HUMANIZER API v2 — LLM-based with detection verification
    // ============================================================

    // POST /api/v1/humanize — Full humanize pipeline
    if (url.pathname === '/api/v1/humanize' || url.pathname === '/humanize') {
      if (!body.text) return jsonRes(res, { error: 'text required' }, 400);
      if (!body.llm_api_key && !body.llm) return jsonRes(res, { error: 'llm_api_key required (or llm object with provider, apiKey, model)' }, 400);

      try {
        const llmConfig = body.llm || {};
        const result = await humanizeText(body.text, {
          llm_provider: llmConfig.provider || body.llm_provider || 'openai',
          llm_api_key: llmConfig.apiKey || body.llm_api_key,
          llm_model: llmConfig.model || body.llm_model,
          llm_base_url: llmConfig.baseUrl || body.llm_base_url,
          detector_api_key: body.detector_api_key || process.env.GPTZERO_API_KEY,
          max_retries: body.max_retries,
          target_score: body.target_score,
          max_chunk_size: body.max_chunk_size,
        });
        return jsonRes(res, result);
      } catch (err) {
        return jsonRes(res, { error: err.message }, 500);
      }
    }

    // POST /api/v1/detect — AI detection only
    if (url.pathname === '/api/v1/detect') {
      if (!body.text) return jsonRes(res, { error: 'text required' }, 400);
      const apiKey = body.detector_api_key || process.env.GPTZERO_API_KEY;
      if (!apiKey) return jsonRes(res, { error: 'detector_api_key required (or set GPTZERO_API_KEY env)' }, 400);

      try {
        const result = await detectOnly(body.text, apiKey);
        return jsonRes(res, result);
      } catch (err) {
        return jsonRes(res, { error: err.message }, 500);
      }
    }

    // Legacy browser-based humanize (kept for backwards compat)
    if (url.pathname === '/humanize/legacy') {
      if (!body.text) return jsonRes(res, { error: 'text required' }, 400);
      const inputPath = join(WORK_DIR, 'input.txt');
      writeFileSync(inputPath, body.text);
      const result = await run('node /app/humanize-script.js ' + inputPath, 600000);
      try {
        return jsonRes(res, JSON.parse(result.trim()));
      } catch {
        return jsonRes(res, { humanized: result.trim() });
      }
    }

    // Medium authentication - initiate login
    if (url.pathname === '/medium/auth') {
      if (!body.email) return jsonRes(res, { error: 'email required' }, 400);
      const result = await run('node /app/medium-auth.js ' + JSON.stringify(body.email), 60000);
      try {
        return jsonRes(res, JSON.parse(result.trim()));
      } catch {
        return jsonRes(res, { output: result.trim() });
      }
    }

    // Medium auth complete - navigate to magic link URL to finish auth
    if (url.pathname === '/medium/auth/complete') {
      if (!body.url) return jsonRes(res, { error: 'magic link url required' }, 400);
      const scriptPath = join(WORK_DIR, 'medium-auth-complete.js');
      writeFileSync(scriptPath, `
        const { chromium } = require('/app/node_modules/playwright-extra');
        const StealthPlugin = require('/app/node_modules/puppeteer-extra-plugin-stealth');
        chromium.use(StealthPlugin());
        const fs = require('fs');
        const COOKIES_PATH = '/tmp/pipeline/medium-cookies.json';
        (async () => {
          const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
          const context = await browser.newContext();
          // Load partial cookies from auth step
          if (fs.existsSync(COOKIES_PATH)) {
            const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
            await context.addCookies(cookies);
          }
          const page = await context.newPage();
          await page.goto(${JSON.stringify(body.url)}, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(10000);
          const finalUrl = page.url();
          const cookies = await context.cookies();
          fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies));
          const loggedIn = !finalUrl.includes('/signin') && !finalUrl.includes('/login');
          console.log(JSON.stringify({ status: loggedIn ? 'authenticated' : 'failed', url: finalUrl }));
          await browser.close();
        })();
      `);
      const result = await run('node ' + scriptPath, 60000);
      try {
        return jsonRes(res, JSON.parse(result.trim()));
      } catch {
        return jsonRes(res, { output: result.trim() });
      }
    }

    // Medium import - import a Dev.to article via Medium's "Import a story" feature
    if (url.pathname === '/medium/import') {
      if (!body.url) return jsonRes(res, { error: 'url required (Dev.to article URL)' }, 400);
      const optionsPath = join(WORK_DIR, 'import-options.json');
      writeFileSync(optionsPath, JSON.stringify({ draft: body.draft !== false }));
      const result = await run('node /app/medium-import.js ' + JSON.stringify(body.url) + ' ' + optionsPath, 120000);
      try {
        return jsonRes(res, JSON.parse(result.trim()));
      } catch {
        return jsonRes(res, { output: result.trim() });
      }
    }

    // Medium publish - post an article (legacy clipboard paste)
    if (url.pathname === '/medium/publish') {
      if (!body.article) return jsonRes(res, { error: 'article (markdown string) required' }, 400);
      const articlePath = join(WORK_DIR, 'article.md');
      const optionsPath = join(WORK_DIR, 'publish-options.json');
      writeFileSync(articlePath, body.article);
      writeFileSync(optionsPath, JSON.stringify({
        title: body.title || null,
        tags: body.tags || [],
        draft: body.draft !== false, // default to draft
      }));
      const result = await run('node /app/medium-publish.js ' + articlePath + ' ' + optionsPath, 120000);
      try {
        return jsonRes(res, JSON.parse(result.trim()));
      } catch {
        return jsonRes(res, { output: result.trim() });
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
          const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
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

    return jsonRes(res, { error: 'not found' }, 404);
  } catch (err) {
    console.error('Error:', err);
    return jsonRes(res, { error: err.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log('Pipeline server running on :' + PORT);
});
