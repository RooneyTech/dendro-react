#!/usr/bin/env node
// Exercise serialization limits and the actual registered MCP handlers together.
const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..');
process.env.DENDRO_WORKSPACE_ROOT = ROOT;
delete process.env.DENDRO_WORKSPACE_HASH;
require('../out/mcp/path-boundary').initWorkspaceRoot();
globalThis.DENDRO_INCLUDE_PRO = false;
const { guardedResponse, MAX_RESPONSE_CHARS } = require('../out/mcp/response-budget');
const { getComponentTree } = require('../out/mcp/tools');
const { createServer } = require('../out/mcp/server');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.stack}`); }
}
function decode(response, limit = MAX_RESPONSE_CHARS) {
  assert(!response.isError, JSON.stringify(response));
  const text = response.content[0].text;
  assert(text.length <= limit, `response length ${text.length} exceeds ${limit}`);
  return JSON.parse(text);
}
function countNodes(tree) { return tree ? 1 + (tree.children || []).reduce((n, child) => n + countNodes(child), 0) : 0; }

(async () => {
  await test('small results retain their exact shape and formatting', () => {
    const input = { summary: { total: 2 }, rows: [{ name: 'a' }, { name: 'b' }], errors: [] };
    assert.equal(guardedResponse(input).content[0].text, JSON.stringify(input, null, 2));
  });
  await test('large nested arrays keep summaries, errors, valid JSON and explicit omission counts', () => {
    const input = { summary: { total: 900 }, rows: Array.from({ length: 900 }, (_, i) => ({ id: i, text: '\\"\n😀'.repeat(100) })), errors: ['A sub-analysis failed'], formattedReport: 'x'.repeat(100_000) };
    const out = decode(guardedResponse(input));
    assert.deepEqual(out.summary, input.summary); assert.deepEqual(out.errors, input.errors);
    assert(out.rows.length > 0 && out.rows.length < 900);
    assert(out._output.partial);
    assert(out._output.omissions.some(o => o.path === '/rows' && o.total === 900 && o.returned === out.rows.length));
    assert(out._output.omissions.some(o => o.path === '/formattedReport' && o.returned === 0));
  });
  await test('the final budget includes escaped strings and omission metadata', () => {
    const input = { rows: Array.from({ length: 200 }, () => '\u0000'.repeat(10_000)) };
    const out = decode(guardedResponse(input, { maxChars: 4_000 }), 4_000);
    assert(out._output.partial); assert(out._output.originalChars > 1_000_000);
  });
  await test('pathological object keys still produce bounded valid JSON', () => {
    const out = decode(guardedResponse({ ['x'.repeat(80_000)]: true }));
    assert(out._output.partial); assert(out._output.note.includes('omitted'));
  });
  await test('own __proto__ JSON fields survive compaction without prototype mutation', () => {
    const input = JSON.parse('{"__proto__":{"value":1},"rows":[]}');
    input.rows = Array(1000).fill('x'.repeat(100));
    const out = decode(guardedResponse(input));
    assert(Object.hasOwn(out, '__proto__')); assert.equal(out.__proto__.value, 1);
  });
  await test('long file locators remain exact under pressure from large node details', () => {
    const absolutePath = '/workspace/' + 'nested-folder/'.repeat(85) + 'Branch.tsx';
    const child = { file: 'Branch.tsx', absolutePath, type: 'functional', state: Array(100).fill('value'.repeat(100)), children: [] };
    const tree = { ...child, children: Array(20).fill(child) };
    const out = decode(guardedResponse({ tree, stats: { totalComponents: 21, maxDepth: 1 } }, { previewTree: true }));
    const visit = node => { assert.equal(node.absolutePath, absolutePath); node.children.forEach(visit); };
    visit(out.tree); assert(out.tree.children.length > 0);
  });
  await test('request and session IDs remain usable when acknowledgment details are compacted', () => {
    const requestId = 'b5ec759d-75a1-4481-9730-5f3d70ce41fd', sessionId = 'f6079de9-741b-4423-9162-1444e15aa121';
    const out = decode(guardedResponse({ requestId, sessionId, results: Array.from({ length: 100 }, () => ({ matched: Array(100).fill('path/'.repeat(200)) })) }));
    assert.equal(out.requestId, requestId); assert.equal(out.sessionId, sessionId); assert(out._output.partial);
  });

  const base = path.join(ROOT, '.dev/releases'); fs.mkdirSync(base, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(base, 'output-budget-test-'));
  const entryFile = path.join(fixture, 'App.tsx');
  // Wide + deep graph, repeated basenames, and many cycles: no dependence on private showcase clones.
  const imports = [];
  for (let i = 0; i < 100; i++) {
    const dir = path.join(fixture, `branch-${i}`); fs.mkdirSync(dir);
    imports.push(`import Branch${i} from './branch-${i}/Branch';`);
    fs.writeFileSync(path.join(dir, 'Branch.tsx'), `import Leaf from './Leaf'; export default function Branch${i}(){return <Leaf/>}`);
    fs.writeFileSync(path.join(dir, 'Leaf.tsx'), `import Deep from './Deep'; export default function Leaf(){return <Deep/>}`);
    fs.writeFileSync(path.join(dir, 'Deep.tsx'), `import Branch from './Branch'; export default function Deep(){return <Branch/>}`);
  }
  fs.writeFileSync(entryFile, imports.join('\n') + '\nexport default function App(){return <main/>}');
  const server = createServer(), client = new Client({ name: 'response-budget-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const call = (name, args) => client.callTool({ name, arguments: args });
    await test('MCP tree retains hierarchy, full-scope statistics and usable file locators', async () => {
      const full = getComponentTree(entryFile);
      const out = decode(await call('get_component_tree', { entryFile }));
      assert.equal(full.stats.totalComponents, 301);
      assert.deepEqual(out.stats, full.stats);
      assert.equal(out.tree.absolutePath, entryFile);
      assert(out.tree.children.length > 0);
      assert(out.tree.children.some(c => c.children.length > 0), 'grandchildren must survive');
      assert.equal(out._output.tree.shownNodes, countNodes(out.tree));
      assert.equal(out._output.tree.omittedNodes, 301 - countNodes(out.tree));
      assert(out._output.tree.omittedNodes > 0);
      const child = out.tree.children[0];
      const expanded = decode(await call('get_component_tree', { entryFile: child.absolutePath, maxDepth: 2 }));
      assert.equal(expanded.tree.absolutePath, child.absolutePath);
      assert.equal(expanded.tree.file, 'Branch.tsx');
      assert.equal(countNodes(expanded.tree), 3);
    });
    await test('MCP maxDepth remains an analysis-scope limit, including depth zero', async () => {
      const out = decode(await call('get_component_tree', { entryFile, maxDepth: 0 }));
      assert.equal(out.stats.totalComponents, 1); assert.deepEqual(out.tree.children, []);
    });
    await test('MCP composite retains a real tree, errors, summaries and bounded cycle samples', async () => {
      const out = decode(await call('analyze_codebase', { entryFile, rootPath: fixture }));
      assert(out.tree.tree.children.length > 0, 'composite must retain its unique tree');
      assert.equal(out.summary.totalComponents, 301);
      assert.equal(out.tree.stats.totalComponents, 301);
      assert(Array.isArray(out.errors));
      assert(out.circularDeps.hasCircularDeps);
      assert(out.circularDeps.circularDependencies.length > 0);
      assert(out._output.partial);
      assert(out._output.followUp.some(f => f.tool === 'get_component_tree'));
      assert.equal(out._output.tree.shownNodes, countNodes(out.tree.tree));
    });
    await test('MCP partial-analysis errors survive large composite compaction', async () => {
      const parser = require('../out/server/parser-oxc'), original = parser.buildComponentTree;
      try {
        parser.buildComponentTree = () => { throw new Error('Injected tree parse failure'); };
        const out = decode(await call('analyze_codebase', { entryFile, rootPath: fixture }));
        assert(out.errors.some(e => e.includes('Injected tree parse failure')));
        assert(out.tree.error); assert.equal(out.tree.tree, null);
        assert(out.complexity.summary.totalComponents > 0);
      } finally { parser.buildComponentTree = original; }
    });
    await test('other guarded analysis tools also obey the final serialized budget', async () => {
      for (const name of ['detect_circular_deps', 'get_complexity_report', 'get_context_map', 'quick_audit']) {
        const out = decode(await call(name, { rootPath: fixture, ...(name === 'quick_audit' ? { baseline: 'off' } : {}) }));
        assert(out && typeof out === 'object');
      }
    });
  } finally { await client.close(); await server.close(); fs.rmSync(fixture, { recursive: true, force: true }); }
  console.log(`\n${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
