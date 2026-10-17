#!/usr/bin/env node
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..');
const ipc = fs.mkdtempSync(path.join(os.tmpdir(), 'dendro-batch-test-'));
process.env.DENDRO_IPC_DIR = ipc; process.env.DENDRO_WORKSPACE_ROOT = ROOT;
delete process.env.DENDRO_WORKSPACE_HASH;
require('../out/mcp/path-boundary').initWorkspaceRoot();
globalThis.DENDRO_INCLUDE_PRO = false;
let dispatch = () => {}, dispatched = 0;
require('child_process').execFile = (_cmd, args, cb) => {
  dispatched++;
  try { dispatch(new URL(args[args.length - 1])); cb(null, '', ''); } catch (e) { cb(e); }
};
const bridge = require('../out/runtime/visualization-batch-bridge');
const tools = require('../out/mcp/tools');
const { webviewRegistry } = require('../out/server/webview-bridge');
const { createServer } = require('../out/mcp/server');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ✓', name); } catch (e) { failed++; console.error('  ✗', name, e.stack); } }
const result = (index, commandType, extra = {}) => ({ index, commandType, success: true, rendered: true, ...extra });
function panel(ready = true, delivery = () => Promise.resolve(true)) {
  const listeners = [], disposals = [], messages = [];
  const p = { onDidDispose: fn => disposals.push(fn), webview: {
    onDidReceiveMessage: fn => listeners.push(fn),
    postMessage: msg => { messages.push(msg); return delivery(); },
  } };
  const sessionId = webviewRegistry.registerPanel(p, path.join(ROOT, 'src/test/fixtures/mcp-tools/App.tsx'));
  const emit = m => listeners.forEach(fn => fn(m));
  if (ready) emit({ type: 'visualizerReady' });
  return { sessionId, messages, emit, dispose: () => disposals.forEach(fn => fn()) };
}
(async () => {
  await test('request IDs are distinct; invalid and unknown IDs cannot access a receipt path', () => {
    const a = bridge.createBatchReceipt(['clear'], false), b = bridge.createBatchReceipt(['clear'], false);
    assert.notEqual(a.requestId, b.requestId); assert.equal(bridge.readBatchReceipt('../elsewhere'), null);
    assert.equal(bridge.readBatchReceipt('00000000-0000-0000-0000-000000000000'), null);
  });
  await test('session binding rejects wrong command types, reuse and cross-panel acknowledgments', () => {
    const r = bridge.createBatchReceipt(['highlight'], false);
    assert(!bridge.bindBatchSession(r.requestId, 'a', ['zoom']));
    assert(bridge.bindBatchSession(r.requestId, 'a', ['highlight']));
    assert(!bridge.bindBatchSession(r.requestId, 'b', ['highlight']));
    assert(!bridge.recordBatchResult(r.requestId, 'b', { status: 'completed', results: [result(0, 'highlight')] }));
    assert.equal(bridge.readBatchReceipt(r.requestId).status, 'queued');
  });
  await test('completion requires each unique command index and its expected type', () => {
    const r = bridge.createBatchReceipt(['clear', 'zoom'], false); bridge.bindBatchSession(r.requestId, 'a', r.commandTypes);
    for (const results of [[result(0, 'clear')], [result(0, 'clear'), result(0, 'clear')], [result(0, 'zoom'), result(1, 'clear')]]) {
      assert(!bridge.recordBatchResult(r.requestId, 'a', { status: 'completed', results }));
    }
    assert(bridge.recordBatchResult(r.requestId, 'a', { status: 'completed', results: [result(0, 'clear'), result(1, 'zoom')] }));
    assert.equal(tools.getVisualizationBatchStatus(r.requestId).success, true);
  });
  await test('missing matches yield partial or failed rather than blanket success', () => {
    for (const rendered of [true, false]) {
      const r = bridge.createBatchReceipt(['highlight'], false); bridge.bindBatchSession(r.requestId, 'a', r.commandTypes);
      bridge.recordBatchResult(r.requestId, 'a', { status: 'completed', results: [result(0, 'highlight', { success: false, rendered, matched: rendered ? ['App'] : [], notFound: ['Typo'] })] });
      const out = tools.getVisualizationBatchStatus(r.requestId); assert.equal(out.success, false);
      assert.equal(out.status, rendered ? 'partial' : 'failed'); assert.deepEqual(out.results[0].notFound, ['Typo']);
    }
  });
  await test('queue receipt remains unconfirmed until the webview reports rendered results', async () => {
    const p = panel(false);
    const r = bridge.createBatchReceipt(['clear'], false);
    assert(webviewRegistry.sendBatch(p.sessionId, [{ type: 'clear' }], false, r.requestId, 0));
    assert.equal(p.messages.length, 0); assert.equal(tools.getVisualizationBatchStatus(r.requestId).success, false);
    p.emit({ type: 'visualizerReady' }); assert.equal(p.messages.length, 1);
    assert.equal(p.messages[0].requestId, r.requestId); assert.equal(p.messages[0].delay, 0);
    p.emit({ type: 'batchResult', requestId: r.requestId, status: 'completed', results: [result(0, 'clear')] });
    assert.equal(tools.getVisualizationBatchStatus(r.requestId).status, 'completed'); p.dispose();
  });
  await test('large accepted acknowledgments stay readable with exact counts and explicit omissions', () => {
    const r = bridge.createBatchReceipt(['highlight'], false); bridge.bindBatchSession(r.requestId, 'a', r.commandTypes);
    const matched = Array.from({ length: 1000 }, (_, i) => '/workspace/' + 'long-directory/'.repeat(160) + i + '.tsx');
    assert(bridge.recordBatchResult(r.requestId, 'a', { status: 'completed', results: [result(0, 'highlight', { matched, notFound: ['Missing'] })] }));
    const out = tools.getVisualizationBatchStatus(r.requestId), item = out.results[0];
    assert.equal(out.status, 'partial'); assert(!out.success);
    assert.equal(item.matchedCount, 1000); assert.equal(item.notFoundCount, 1);
    assert.equal(item.omitted.matched, 1000 - item.matched.length);
    assert(item.matched.every(p => matched.includes(p)), 'paths must remain exact');
    assert(fs.statSync(path.join(ipc, 'visualization-batches', r.requestId + '.json')).size < 2_000_000);
  });
  await test('false, rejected and thrown webview deliveries report explicit failure', async () => {
    for (const delivery of [() => Promise.resolve(false), () => Promise.reject(Error('closed')), () => { throw Error('closed'); }]) {
      const p = panel(true, delivery), r = bridge.createBatchReceipt(['clear'], false);
      webviewRegistry.sendBatch(p.sessionId, [{ type: 'clear' }], false, r.requestId);
      await Promise.resolve();
      assert.equal(tools.getVisualizationBatchStatus(r.requestId).status, 'failed'); p.dispose();
    }
  });
  await test('Back progress replaces the current prefix rather than preserving later steps', () => {
    const r = bridge.createBatchReceipt(['clear', 'zoom'], true); bridge.bindBatchSession(r.requestId, 'a', r.commandTypes);
    bridge.recordBatchResult(r.requestId, 'a', { status: 'waiting_for_user', results: [result(0, 'clear'), result(1, 'zoom')] });
    bridge.recordBatchResult(r.requestId, 'a', { status: 'running', results: [] });
    bridge.recordBatchResult(r.requestId, 'a', { status: 'waiting_for_user', results: [result(0, 'clear')] });
    assert.equal(tools.getVisualizationBatchStatus(r.requestId).pendingCount, 1);
  });
  await test('closing a queued or running panel reports failure to the waiting caller', () => {
    const p = panel(false), r = bridge.createBatchReceipt(['clear'], false);
    webviewRegistry.sendBatch(p.sessionId, [{ type: 'clear' }], false, r.requestId); p.dispose();
    const out = tools.getVisualizationBatchStatus(r.requestId); assert.equal(out.status, 'failed'); assert(out.error.includes('closed'));
  });
  await test('a different panel cannot forge a valid request result', () => {
    const a = panel(), b = panel(), r = bridge.createBatchReceipt(['clear'], false);
    webviewRegistry.sendBatch(a.sessionId, [{ type: 'clear' }], false, r.requestId);
    b.emit({ type: 'batchResult', requestId: r.requestId, status: 'completed', results: [result(0, 'clear')] });
    assert.equal(tools.getVisualizationBatchStatus(r.requestId).status, 'queued'); a.dispose(); b.dispose();
  });
  await test('timeout preserves a resumable request and late genuine completion is readable', async () => {
    const r = bridge.createBatchReceipt(['clear'], false);
    const start = Date.now(), out = await tools.awaitVisualizationBatch(r.requestId, 100);
    assert.equal(out.status, 'timed_out'); assert(!out.success); assert(Date.now() - start < 1000);
    bridge.bindBatchSession(r.requestId, 'a', r.commandTypes);
    bridge.recordBatchResult(r.requestId, 'a', { status: 'completed', results: [result(0, 'clear')] });
    assert(tools.getVisualizationBatchStatus(r.requestId).success);
  });
  await test('manual pause returns promptly with pending steps; skip and supersede stay terminal', async () => {
    for (const terminal of ['skipped', 'superseded']) {
      const r = bridge.createBatchReceipt(['clear', 'zoom'], true); bridge.bindBatchSession(r.requestId, 'a', r.commandTypes);
      bridge.recordBatchResult(r.requestId, 'a', { status: 'waiting_for_user', results: [result(0, 'clear')] });
      const out = await tools.awaitVisualizationBatch(r.requestId, 1000);
      assert.equal(out.status, 'waiting_for_user'); assert.equal(out.pendingCount, 1); assert(!out.success);
      bridge.recordBatchResult(r.requestId, 'a', { status: terminal, results: out.results });
      assert(!bridge.recordBatchResult(r.requestId, 'a', { status: 'completed', results: [result(0, 'clear'), result(1, 'zoom')] }));
      assert.equal(tools.getVisualizationBatchStatus(r.requestId).status, terminal);
    }
  });
  await test('failed URI dispatch has an explicit failure receipt', async () => {
    dispatch = () => { throw Error('opener unavailable'); };
    const queued = tools.visualizeBatch([{ type: 'clear' }]); assert(!queued.success);
    const out = await tools.awaitVisualizationBatch(queued.requestId, 100); assert.equal(out.status, 'failed'); assert(out.error.includes('opener unavailable'));
  });

  const server = createServer(), client = new Client({ name: 'batch-bridge-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st); await client.connect(ct);
    const call = async args => {
      const r = await client.callTool({ name: 'visualize_batch', arguments: args }); assert(!r.isError, JSON.stringify(r));
      return JSON.parse(r.content[0].text);
    };
    await test('registered MCP execute waits for the correlated extension/webview receipt', async () => {
      const p = panel();
      dispatch = uri => {
        const id = uri.searchParams.get('requestId'), commands = JSON.parse(uri.searchParams.get('commands'));
        webviewRegistry.sendBatch(p.sessionId, commands, false, id, 0);
        setTimeout(() => p.emit({ type: 'batchResult', requestId: id, status: 'completed', results: [result(0, 'clear')] }), 20);
      };
      const out = await call({ commands: [{ type: 'clear' }], timeoutMs: 1000 });
      assert(out.success); assert.equal(out.renderedCount, 1); assert.equal(out.sessionId, p.sessionId);
      const before = dispatched, status = await call({ action: 'status', requestId: out.requestId });
      assert.equal(dispatched, before, 'status must not redispatch'); assert.equal(status.status, 'completed'); p.dispose();
    });
    await test('registered MCP returns queued without falsely reporting rendering when opted out', async () => {
      dispatch = () => {};
      const out = await call({ commands: [{ type: 'clear' }], waitForResult: false });
      assert.equal(out.status, 'queued'); assert(!out.success); assert.equal(out.renderedCount, 0);
    });
    await test('registered MCP validates status requests and surfaces unacknowledged batches', async () => {
      assert((await call({ action: 'status' })).error);
      const out = await call({ commands: [{ type: 'clear' }], timeoutMs: 100 });
      assert.equal(out.status, 'timed_out'); assert(!out.success);
    });
  } finally { await client.close(); await server.close(); fs.rmSync(ipc, { recursive: true, force: true }); }
  console.log(`\n${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); fs.rmSync(ipc, { recursive: true, force: true }); process.exitCode = 1; });
