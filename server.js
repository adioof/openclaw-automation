const http = require('http');
const { exec, execSync } = require('child_process');
const { writeFileSync, mkdirSync, existsSync } = require('fs');
const { join } = require('path');

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
        const { chromium } = require('playwright-core');
        const fs = require('fs');
        (async () => {
          const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
          const page = await browser.newPage();
          await page.goto('https://www.humanizeai.io/', { waitUntil: 'networkidle', timeout: 30000 });
          const input = fs.readFileSync('${inputPath}', 'utf8');
          await page.locator('textarea').first().fill(input);
          await page.locator('button', { hasText: /humanize/i }).first().click();
          await page.waitForTimeout(15000);
          const textareas = await page.locator('textarea').all();
          let output = '';
          if (textareas.length > 1) output = await textareas[1].inputValue();
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
        const { chromium } = require('playwright-core');
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
