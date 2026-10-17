#!/usr/bin/env node
// Connected browser proof for render-grounded visualization batch receipts.
// Build first: npx webpack --config webpack.config.js --config-name webview
// Run: node e2e/tier3-webview/batch-results.e2e.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '../..');
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.woff2': 'font/woff2' };
const fixture = {
  file: 'Root.tsx', absolutePath: '/project/Root.tsx', type: 'functional', state: [],
  children: [{ file: 'Child.tsx', absolutePath: '/project/Child.tsx', type: 'functional', state: [], children: [] }],
};
const duplicateFixture = {
  ...fixture,
  children: [
    { file: 'Card.tsx', absolutePath: '/project/a/Card.tsx', type: 'functional', state: [], children: [] },
    { file: 'Card.tsx', absolutePath: '/project/b/Card.tsx', type: 'functional', state: [], children: [] },
  ],
};
// Shape emitted by buildRuntimeHierarchy/runtimeToDendrogram: repeated
// instances share their display name and source file, but keep unique IDs.
const runtimeFixture = {
  file: 'App', type: 'functional', state: [], _runtime: true, _runtimeId: 1,
  _displayName: 'App', _sourceFile: '/project/App.tsx', _runtimeType: 'function',
  children: [11, 12].map(id => ({ file: 'Card', type: 'functional', state: [], children: [],
    _runtime: true, _runtimeId: id, _displayName: 'Card', _sourceFile: '/project/Card.tsx', _runtimeType: 'function' })),
};
let assertions = 0;
function check(value, message) { assert.ok(value, message); assertions++; console.log(`  ✓ ${message}`); }

async function load(page, port, tree = fixture, runtime = false) {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.evaluate(({ data, runtime }) => {
    window._capturedMessages = [];
    window.vscode.postMessage = message => {
      const nodes = Array.from(document.querySelectorAll('g.node')).map(element => ({
        path: element.__data__?.data?.absolutePath || element.__data__?.data?.file,
        runtimeId: element.__data__?.data?._runtimeId,
        color: element.querySelector('.node-rect') ? getComputedStyle(element.querySelector('.node-rect')).fill : null,
      }));
      window._capturedMessages.push({ ...message, observed: { time: performance.now(), nodes,
        labels: Array.from(document.querySelectorAll('.highlight-labels-layer text')).map(element => element.textContent),
        annotationCount: document.querySelectorAll('.annotation-callout').length,
        flowCount: document.querySelectorAll('.flow-path').length,
        transform: document.querySelector('svg > g')?.getAttribute('transform'),
      } });
    };
    window.postMessage({ type: runtime ? 'runtimeTreeData' : 'astData',
      payload: { treeData: data, filePath: data.absolutePath, componentCount: 3, sessionId: 'batch-result-proof' } }, '*');
  }, { data: tree, runtime });
  await page.waitForFunction(() => typeof window.dendroHandleBatchCommands === 'function' && document.querySelectorAll('g.node').length >= 2);
  await page.waitForFunction(() => {
    const elements = [document.querySelector('svg'), ...document.querySelectorAll('g.node')];
    return elements.every(element => !element.__transition);
  });
}
async function batch(page, requestId, commands, waitForUser = false, delay = 0) {
  return page.evaluate(({ requestId, commands, waitForUser, delay }) => {
    const started = performance.now();
    window.postMessage({ type: 'batchVisualizerCommands', requestId, commands, waitForUser, delay }, '*');
    return started;
  }, { requestId, commands, waitForUser, delay });
}
async function status(page, requestId, expected, count) {
  await page.waitForFunction(({ requestId, expected, count }) => window._capturedMessages.some(message =>
    message.type === 'batchResult' && message.requestId === requestId && message.status === expected &&
    (count == null || message.results.length === count)), { requestId, expected, count }, { timeout: 12000 });
  return page.evaluate(({ requestId, expected, count }) => window._capturedMessages.filter(message =>
    message.type === 'batchResult' && message.requestId === requestId && message.status === expected &&
    (count == null || message.results.length === count)).at(-1), { requestId, expected, count });
}
const highlight = (nodes, color, label, alias = 'nodes') => ({ type: 'highlight', payload: { [alias]: nodes, color, label, pulse: false } });

async function proveCommands(page, port) {
  await load(page, port);
  await batch(page, 'effects', [
    highlight(['Root'], 'green', 'first', 'components'),
    highlight(['Child.tsx'], 'orange', 'second', 'targets'),
    { type: 'annotate', payload: { nodeId: 'Root.tsx', text: 'Verified\nannotation' } },
    { type: 'traceFlow', payload: { nodes: ['Root', 'Child'], label: 'Verified flow', animated: false } },
    { type: 'zoom', payload: { component: 'Child', duration: 180 } },
    { type: 'fitAll', payload: { duration: 150 } },
    { type: 'collapse', payload: { nodeId: 'Root.tsx' } },
    { type: 'expand', payload: { nodeId: 'Root.tsx', recursive: true } },
  ]);
  const done = await status(page, 'effects', 'completed');
  check(done.results.length === 8 && done.results.every(result => result.success && result.rendered), 'Every command type confirms its actual effect');
  check(done.results.every((result, index) => result.index === index), 'Results preserve original command indexes');
  const cumulative = await status(page, 'effects', 'running', 2);
  check(cumulative.observed.labels.includes('first') && cumulative.observed.labels.includes('second'), 'Alias highlights remain cumulative at acknowledgment');
  const annotation = await status(page, 'effects', 'running', 3);
  const flow = await status(page, 'effects', 'running', 4);
  check(annotation.observed.annotationCount === 1 && flow.observed.flowCount === 1, 'Annotation and flow acknowledgments observe the actual overlay DOM');
  const collapsed = await status(page, 'effects', 'running', 7);
  check(collapsed.observed.nodes.length === 1 && done.observed.nodes.length === 2, 'Collapse and expand receipts observe settled target membership');
  await batch(page, 'clear', [{ type: 'clear', payload: { clearType: 'all' } }]);
  const cleared = await status(page, 'clear', 'completed');
  check(cleared.results[0].rendered && !cleared.observed.labels.length && !cleared.observed.annotationCount && !cleared.observed.flowCount, 'Clear confirms overlay removal in the DOM');
  await batch(page, 'unlabeled', [highlight(['Root'], 'red'), highlight(['Child'], 'orange')]);
  const unlabeled = await status(page, 'unlabeled', 'completed');
  await batch(page, 'targeted-clear', [{ type: 'clear', payload: { clearType: 'highlights', ids: ['Root'] } }]);
  const targeted = await status(page, 'targeted-clear', 'completed');
  check(targeted.results[0].rendered && targeted.observed.nodes.find(node => node.path === '/project/Root.tsx').color !== unlabeled.observed.nodes.find(node => node.path === '/project/Root.tsx').color &&
    targeted.observed.nodes.find(node => node.path === '/project/Child.tsx').color === unlabeled.observed.nodes.find(node => node.path === '/project/Child.tsx').color, 'Targeted clear resolves aliases and verifies unlabeled highlight removal while preserving other highlights');
  const started = await batch(page, 'animated', [{ type: 'zoom', payload: { target: 'Child', duration: 400 } }]);
  const zoomed = await status(page, 'animated', 'completed');
  check(zoomed.results[0].success && zoomed.observed.time - started >= 390, 'Zoom waits for D3 animation completion before acknowledging');
}
async function proveSelectors(page, port) {
  await load(page, port, duplicateFixture);
  await batch(page, 'selectors', [
    highlight(['Root', 'Missing'], 'green', 'partial'),
    highlight(['Card.tsx'], 'orange', 'ambiguous'),
    highlight(['/project/a/Card.tsx'], 'orange', 'exact'),
    highlight(['Missing'], 'red', 'absent'),
    highlight(['/other-project/Root.tsx'], 'red', 'wrong path'),
  ]);
  const result = await status(page, 'selectors', 'completed');
  check(!result.results[0].success && result.results[0].rendered && result.results[0].notFound.includes('Missing'), 'Partial matches report rendered effects and missing selectors without full success');
  check(!result.results[1].rendered && result.results[1].error.includes('Ambiguous'), 'Duplicate basenames are rejected instead of guessed');
  check(result.results[2].success && result.results[2].matched[0] === '/project/a/Card.tsx', 'Exact absolute paths disambiguate selectors');
  const exact = await status(page, 'selectors', 'running', 3);
  const a = exact.observed.nodes.find(node => node.path === '/project/a/Card.tsx');
  const b = exact.observed.nodes.find(node => node.path === '/project/b/Card.tsx');
  check(a.color !== b.color && exact.observed.labels.filter(label => label === 'exact').length === 1, 'Exact-path highlight changes only the selected duplicate');
  check(!result.results[3].success && !result.results[3].rendered && result.results[3].notFound[0] === 'Missing', 'Entirely missing selectors cannot produce a rendered success');
  check(!result.results[4].rendered && result.results[4].notFound[0] === '/other-project/Root.tsx', 'An incorrect absolute path cannot fall back to a guessed basename');
}
async function proveRuntimeInstances(page, port) {
  await load(page, port, runtimeFixture, true);
  await batch(page, 'runtime-instances', [
    highlight(['Card'], 'red', 'ambiguous runtime name'),
    highlight(['11'], 'orange', 'only instance 11'),
    { type: 'annotate', payload: { nodeId: '11', text: 'Instance 11 annotation', position: 'top' } },
    { type: 'zoom', payload: { target: '11', duration: 180 } },
  ]);
  const completed = await status(page, 'runtime-instances', 'completed');
  check(!completed.results[0].rendered && completed.results[0].error.includes('Ambiguous') &&
    completed.results.slice(1).every(result => result.success && result.rendered && result.matched.join(',') === '11'),
    'Runtime instance IDs remain canonical through highlight, annotation, and zoom handlers');
  const highlighted = await status(page, 'runtime-instances', 'running', 2);
  check(highlighted.observed.nodes.find(node => node.runtimeId === 11).color !== highlighted.observed.nodes.find(node => node.runtimeId === 12).color &&
    highlighted.observed.labels.filter(label => label === 'only instance 11').length === 1,
    'Highlighting runtime ID 11 changes that instance while its same-source sibling stays unhighlighted');
  check(await page.evaluate(() => {
    const node = Array.from(document.querySelectorAll('g.node')).find(element => element.__data__?.data?._runtimeId === 11).__data__;
    const annotation = document.querySelector('.annotation-callout');
    return document.querySelectorAll('.annotation-callout').length === 1 &&
      annotation.getAttribute('transform') === `translate(${node.x},${node.y - 80})` && annotation.textContent.includes('Instance 11 annotation');
  }), 'Runtime annotation is positioned at instance 11 rather than the sibling sharing its source');
  check(await page.evaluate(() => {
    const circles = Array.from(document.querySelectorAll('g.node')).filter(element => [11, 12].includes(element.__data__?.data?._runtimeId))
      .map(element => ({ id: element.__data__.data._runtimeId, bounds: element.querySelector('.node-soma').getBoundingClientRect() }));
    const target = circles.find(element => element.id === 11).bounds;
    const sibling = circles.find(element => element.id === 12).bounds;
    return Math.abs(target.x + target.width / 2 - innerWidth / 2) < 2 &&
      Math.abs(target.y + target.height / 2 - innerHeight / 2) < 2 && Math.abs(sibling.x + sibling.width / 2 - innerWidth / 2) > 20;
  }), 'Runtime zoom actually centers the requested instance after its animation');
  await batch(page, 'runtime-shared-source', [highlight(['/project/Card.tsx'], 'red', 'ambiguous source')]);
  const ambiguous = await status(page, 'runtime-shared-source', 'completed');
  check(!ambiguous.results[0].rendered && ambiguous.results[0].error.includes('Ambiguous'),
    'Shared runtime source paths remain ambiguous even though instance IDs can disambiguate them');
}

async function proveInvisibleEffects(page, port) {
  await load(page, port);
  await batch(page, 'invalid-flow-color', [{ type: 'traceFlow', payload: { nodes: ['Root', 'Child'], color: 'not-a-color' } }]);
  const invalid = await status(page, 'invalid-flow-color', 'completed');
  check(!invalid.results[0].success && !invalid.results[0].rendered && invalid.results[0].error.includes('flow color') && !invalid.observed.flowCount,
    'Invalid flow colors fail before an invisible path is added');
  const block = await page.addStyleTag({ content: '.flow-path { stroke: none !important; }' });
  await batch(page, 'invisible-flow', [{ type: 'traceFlow', payload: { nodes: ['Root', 'Child'], color: 'red', animated: false } }]);
  const invisible = await status(page, 'invisible-flow', 'completed');
  check(!invisible.results[0].success && !invisible.results[0].rendered && invisible.results[0].error.includes('timed out') &&
    await page.evaluate(() => { const path = document.querySelector('.flow-path'); return path.getTotalLength() > 0 && getComputedStyle(path).stroke === 'none'; }),
    'A flow with valid geometry and a CSS-hidden stroke cannot produce a rendered acknowledgment');
  await block.evaluate(element => element.remove());
  await page.evaluate(() => { document.getElementById('root').style.opacity = '0'; });
  await batch(page, 'hidden-map', [highlight(['Root'], 'green', 'hidden map effect')]);
  const hidden = await status(page, 'hidden-map', 'completed');
  check(!hidden.results[0].success && !hidden.results[0].rendered && hidden.results[0].error.includes('timed out'),
    'An opacity-hidden map cannot acknowledge a rendered effect from geometry and fill alone');
  await page.evaluate(() => { document.getElementById('root').style.opacity = ''; });
  const hiddenShape = await page.addStyleTag({ content: '.node-rect { visibility: hidden !important; }' });
  await batch(page, 'hidden-highlight-shape', [highlight(['Child'], 'orange')]);
  const shape = await status(page, 'hidden-highlight-shape', 'completed');
  check(!shape.results[0].success && !shape.results[0].rendered && shape.results[0].error.includes('timed out'),
    'A hidden highlight shape cannot produce a rendered acknowledgment while its map remains visible');
  await hiddenShape.evaluate(element => element.remove());
  const hiddenText = await page.addStyleTag({ content: '.annotation-callout text { display: none !important; }' });
  await batch(page, 'hidden-annotation-text', [{ type: 'annotate', payload: { nodeId: 'Root', text: 'Hidden annotation text' } }]);
  const annotation = await status(page, 'hidden-annotation-text', 'completed');
  check(!annotation.results[0].success && !annotation.results[0].rendered && annotation.results[0].error.includes('timed out'),
    'A visible callout with hidden annotation text cannot produce a rendered acknowledgment');
  await hiddenText.evaluate(element => element.remove());
}

async function proveManualAndCancellation(page, port) {
  await load(page, port);
  await page.evaluate(() => {
    window.dendroHandleBatchCommands([
      { type: 'highlight', payload: { nodes: ['Root'], color: 'green', label: 'manual first' } },
      { type: 'highlight', payload: { nodes: ['Child'], color: 'orange', label: 'manual second' } },
      { type: 'annotate', payload: { nodeId: 'Root', text: 'never applied' } },
    ], true, { requestId: 'manual', delay: 0 });
    window._synchronousBatchMessages = window._capturedMessages.filter(message => message.requestId === 'manual');
  });
  check(await page.evaluate(() => window._synchronousBatchMessages.every(message => message.status === 'running' && message.results.length === 0)), 'No rendered or waiting acknowledgment is sent synchronously from the handler');
  const first = await status(page, 'manual', 'waiting_for_user', 1);
  check(first.results[0].rendered && first.observed.labels.includes('manual first'), 'Manual batch pauses only after first actual rendered command');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await status(page, 'manual', 'waiting_for_user', 2);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  // Distinguish replay from the first historical waiting message.
  await page.waitForFunction(() => window._capturedMessages.filter(message => message.requestId === 'manual' && message.status === 'waiting_for_user' && message.results.length === 1).length === 2);
  const replay = await status(page, 'manual', 'waiting_for_user', 1);
  check(replay.results[0].index === 0 && replay.observed.labels.includes('manual first') && !replay.observed.labels.includes('manual second'), 'Back replays a correct prefix and removes later effects');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.waitForFunction(() => window._capturedMessages.filter(message => message.requestId === 'manual' && message.status === 'waiting_for_user' && message.results.length === 2).length === 2);
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  const skipped = await status(page, 'manual', 'skipped');
  check(skipped.results.map(result => result.index).join(',') === '0,1' && skipped.observed.annotationCount === 0, 'Skip reports the applied prefix and leaves remaining commands unapplied');
  await batch(page, 'old', [
    { type: 'zoom', payload: { target: 'Root', duration: 700 } },
    { type: 'annotate', payload: { nodeId: 'Root', text: 'stale command' } },
  ], false, 300);
  await page.waitForTimeout(70); // Replace while the real D3 transition is running.
  await batch(page, 'replacement', [highlight(['Child'], 'red', 'replacement')]);
  await status(page, 'old', 'superseded');
  const replacement = await status(page, 'replacement', 'completed');
  await page.waitForTimeout(1000); // Exceed canceled animation + queue delay.
  const oldMessages = await page.evaluate(() => window._capturedMessages.filter(message => message.requestId === 'old'));
  check(!oldMessages.some(message => message.status === 'completed') && oldMessages.at(-1).status === 'superseded', 'Superseded batches cannot emit late completion acknowledgments');
  check(replacement.results[0].rendered && await page.locator('.annotation-callout').count() === 0, 'Replacement aborts old queued effects while the new batch renders');
  await batch(page, 'delayed', [highlight(['Root'], 'green', 'delayed root'), { type: 'annotate', payload: { nodeId: 'Child', text: 'stale delayed command' } }], false, 700);
  await status(page, 'delayed', 'running', 1);
  await batch(page, 'after-delay', [{ type: 'clear', payload: { clearType: 'all' } }]);
  await status(page, 'after-delay', 'completed');
  await page.waitForTimeout(850);
  check(await page.locator('.annotation-callout').count() === 0, 'Replacing a batch also cancels its inter-command delay timer');
}
async function proveFailureAndCompatibility(page, port) {
  await load(page, port);
  await page.addStyleTag({ content: '.node-rect { fill: black !important; }' });
  await batch(page, 'blocked', [highlight(['Root'], 'red', 'blocked')]);
  const failed = await status(page, 'blocked', 'completed');
  check(!failed.results[0].success && !failed.results[0].rendered && failed.results[0].error.includes('timed out'), 'A blocked DOM effect fails within a finite settlement deadline');
  await page.evaluate(() => document.querySelectorAll('style').forEach(element => { if (element.textContent.includes('fill: black !important')) element.remove(); }));
  await batch(page, 'manual-failure', [highlight(['Absent'], 'red'), highlight(['Root'], 'green', 'actual first'), highlight(['Child'], 'orange')], true);
  const waiting = await status(page, 'manual-failure', 'waiting_for_user', 2);
  check(!waiting.results[0].rendered && waiting.results[1].rendered, 'Manual batches advance past failed commands until an actual rendered effect');
  const beforeBack = await page.evaluate(() => window._capturedMessages.length);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  check(await page.evaluate(() => window._capturedMessages.length) === beforeBack, 'Back cannot pause on an earlier failed-only step');
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.evaluate(() => {
    window._capturedMessages = [];
    window.postMessage({ type: 'visualizerCommand', command: { type: 'highlight', payload: { nodes: ['Child'], color: 'orange' } } }, '*');
  });
  await page.waitForFunction(() => window._capturedMessages.some(message => message.type === 'commandResult'));
  const individual = await page.evaluate(() => window._capturedMessages.find(message => message.type === 'commandResult'));
  check(individual.result.success && individual.result.rendered, 'Individual commands retain commandResult compatibility with render confirmation');
}
async function main() {
  const server = http.createServer((request, response) => {
    const url = request.url.split('?')[0];
    const file = url === '/' ? path.join(__dirname, 'harness.html') : path.join(ROOT, url);
    if (!fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.setHeader('content-type', mime[path.extname(file)] || 'application/octet-stream');
    response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  try {
    const port = server.address().port;
    await proveCommands(page, port);
    await proveSelectors(page, port);
    await proveRuntimeInstances(page, port);
    await proveInvisibleEffects(page, port);
    await proveManualAndCancellation(page, port);
    await proveFailureAndCompatibility(page, port);
    check(errors.length === 0, `No uncaught browser errors (${errors.join('; ')})`);
    console.log(`\n${assertions} render receipt browser assertions passed.`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
