#!/usr/bin/env node
// Visual self-review (usage: node capture-walkthrough-frames.js [outDir]): drive the real webview bundle through a waitForUser
// walkthrough, clicking Next like a human, screenshotting every step.
const http = require('http');
const path = require('path');
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '../..');
const OUT = process.argv[2] || require('path').join(require('os').tmpdir(), 'dendro-frames');
const HARNESS = path.join(ROOT, 'e2e/tier3-webview/harness.html');
const FIXTURE = path.join(ROOT, '.dev/capture/fixtures/tictactoe-tree.json');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      const filePath = (url === '/' || url === '/harness') ? HARNESS : path.join(ROOT, url);
      if (!fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(fs.readFileSync(filePath));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const playwright = require('playwright');
  const { server, port } = await startServer();
  const browser = await playwright.chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`http://127.0.0.1:${port}/harness`);
  await page.waitForLoadState('networkidle');
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));
  await page.evaluate((data) => {
    window.vscode = { postMessage: () => {} };
    window.postMessage({ type: 'astData', payload: { treeData: data.treeData, filePath: data.filePath, sessionId: data.sessionId }, appName: data.appName }, '*');
  }, fixture);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, 'frame-0-initial.png') });

  await page.evaluate(() => {
    window.postMessage({
      type: 'batchVisualizerCommands',
      commands: [
        { type: 'fitAll', payload: {}, label: 'The full component tree of the app' },
        { type: 'highlight', payload: { nodes: ['Game.jsx'], color: 'green' }, label: 'Entry point in green — the Game component owns all state' },
        { type: 'highlight', payload: { nodes: ['Board.jsx'], color: 'orange' }, label: 'A deliberately long walkthrough sentence to check that the control bar wraps text onto multiple lines instead of truncating it with an ellipsis at the four hundred pixel mark' },
        { type: 'zoom', payload: { target: 'Square.jsx' }, label: 'A deliberately long walkthrough sentence to check that the control bar wraps text onto multiple lines instead of truncating it with an ellipsis' },
      ],
      waitForUser: true,
    }, '*');
  });
  await page.waitForTimeout(1200);

  for (let step = 1; step <= 4; step++) {
    await page.screenshot({ path: path.join(OUT, `frame-${step}.png`) });
    const next = page.locator('button', { hasText: 'Next' });
    if (await next.count() === 0) break;
    await next.first().click();
    await page.waitForTimeout(1000);
  }
  await page.screenshot({ path: path.join(OUT, 'frame-final.png') });
  console.log('pageerrors:', errors.length ? errors : 'none');
  await browser.close();
  server.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
