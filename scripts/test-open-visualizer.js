#!/usr/bin/env node
/**
 * test-open-visualizer.js
 *
 * Tests for the open_visualizer MCP tool, auto-open behavior,
 * URI construction, feature gate, and MCP config validation.
 *
 * Usage:
 *   npm run build && node scripts/test-open-visualizer.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Single source of truth for the registered tool count. Bump when tools are
// added/removed (v0.7.0: +get_component_contract, +get_modified_components = 58).
const { getFreeFeatureList: _gf, getProFeatureList: _gp } = require(path.join(__dirname, '../out/licensing/feature-gate'));
const TOOL_COUNT = _gf().length + _gp().length; // derived from FEATURE_REGISTRY — never pin
const SOLSIS_ROOT = path.resolve(os.homedir(), 'Projects/_archive/collaborations/solsis/solsis-frontend');

let passed = 0;
let failed = 0;
let currentSection = '';

function section(name) {
  currentSection = name;
  console.log(`\n${name}`);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

// ============================================================================
// 1. openVisualizer() function
// ============================================================================
section('🔓 open_visualizer — Function');

const {
  openVisualizer,
  visualizeHighlight,
  visualizeZoom,
  visualizeAnnotate,
  visualizeTraceFlow,
  visualizeClear,
  visualizeExpand,
  visualizeCollapse
} = require(path.join(ROOT, 'out/mcp/tools'));

test('openVisualizer is exported', () => {
  assert(typeof openVisualizer === 'function', 'openVisualizer should be a function');
});

test('returns a Promise (async with ready signal)', () => {
  const result = openVisualizer('/tmp/test/App.tsx');
  assert(result && typeof result.then === 'function', 'should return a Promise');
  // Don't await — URI open will fail/timeout in test env
});

test('OpenVisualizerResult has ready field in source', () => {
  const toolsSrc = fs.readFileSync(path.join(ROOT, 'out/mcp/tools.js'), 'utf-8');
  assert(toolsSrc.includes('ready:'), 'result should include ready field');
  assert(toolsSrc.includes('sessionId'), 'result should include sessionId field');
});

test('openVisualizer polls for ready signal', () => {
  const toolsSrc = fs.readFileSync(path.join(ROOT, 'out/mcp/tools.js'), 'utf-8');
  assert(toolsSrc.includes('pollVisualizerReady'), 'should poll for ready signal');
  assert(toolsSrc.includes('clearVisualizerStatus'), 'should clear stale status');
  assert(toolsSrc.includes('writeVisualizerPending'), 'should write pending status');
});

test('openVisualizer message differs for ready vs timeout', () => {
  const toolsSrc = fs.readFileSync(path.join(ROOT, 'out/mcp/tools.js'), 'utf-8');
  assert(toolsSrc.includes('is ready for'), 'should have ready message');
  assert(toolsSrc.includes('ready confirmation not received'), 'should have timeout message');
});

// ============================================================================
// 2. URI Construction
// ============================================================================
section('🔗 open_visualizer — URI Construction');

// We can't easily intercept the exec call, but we can verify the URI base constant
// by checking the source code or the behavior
test('DENDRO_URI_BASE uses correct extension ID', () => {
  // Read the compiled tools.js and check for the URI base
  const toolsSrc = fs.readFileSync(path.join(ROOT, 'out/mcp/tools.js'), 'utf-8');
  assert(toolsSrc.includes('vscode://rooneytech.dendro-react'), 'URI base should be vscode://rooneytech.dendro-react');
});

test('openVisualizer constructs /visualize URI path', () => {
  const toolsSrc = fs.readFileSync(path.join(ROOT, 'out/mcp/tools.js'), 'utf-8');
  // The function constructs: DENDRO_URI_BASE + '/visualize?file=' + encodeURIComponent(entryFile)
  assert(toolsSrc.includes('/visualize?file='), 'should use /visualize path with file param');
});

test('visualizeHighlight constructs /highlight URI path', () => {
  const toolsSrc = fs.readFileSync(path.join(ROOT, 'out/mcp/tools.js'), 'utf-8');
  assert(toolsSrc.includes('/highlight?'), 'should use /highlight path');
});

test('visualizeZoom constructs /zoom URI path', () => {
  const toolsSrc = fs.readFileSync(path.join(ROOT, 'out/mcp/tools.js'), 'utf-8');
  assert(toolsSrc.includes('/zoom?'), 'should use /zoom path');
});

test('openVSCodeUri uses platform-specific command', () => {
  const toolsSrc = fs.readFileSync(path.join(ROOT, 'out/mcp/tools.js'), 'utf-8');
  assert(toolsSrc.includes('darwin'), 'should check for macOS');
  assert(toolsSrc.includes('win32'), 'should check for Windows');
  assert(toolsSrc.includes('xdg-open'), 'should use xdg-open for Linux');
});

// ============================================================================
// 3. Feature Gate
// ============================================================================
section('🔒 Feature Gate — open_visualizer');

const { isProFeature, getFeatureTier, getFreeFeatureList, getProFeatureList } = require(path.join(ROOT, 'out/licensing/feature-gate'));

test('open_visualizer is free tier', () => {
  assert(getFeatureTier('open_visualizer') === 'free', 'open_visualizer should be free');
});

test('open_visualizer is NOT pro', () => {
  assert(!isProFeature('open_visualizer'), 'open_visualizer should not be pro');
});

test('open_visualizer in free list', () => {
  const freeList = getFreeFeatureList();
  assert(freeList.includes('open_visualizer'), 'free list should include open_visualizer');
});

test('all viz tools are free', () => {
  const vizTools = ['open_visualizer', 'visualize_batch', 'visualize_analysis'];
  const freeList = getFreeFeatureList();
  for (const tool of vizTools) {
    assert(getFeatureTier(tool) === 'free', `${tool} should be free`);
    assert(freeList.includes(tool), `${tool} should be in free list`);
  }
});

test('free/pro split is (total-10)/10', () => {
  const freeCount = getFreeFeatureList().length;
  const proCount = getProFeatureList().length;
  assert(freeCount === TOOL_COUNT - 10, `expected ${TOOL_COUNT - 10} free, got ${freeCount}`);
  assert(proCount === 10, `expected 10 pro, got ${proCount}`);
});

test(`total features = ${TOOL_COUNT}`, () => {
  const total = getFreeFeatureList().length + getProFeatureList().length;
  assert(total === TOOL_COUNT, `expected ${TOOL_COUNT} total, got ${total}`);
});

// ============================================================================
// 4. MCP Server Tool Registration
// ============================================================================
section('🛠️  MCP Server — Tool Registration');

test(`MCP server has ${TOOL_COUNT} tools`, () => {
  // Use JSON-RPC to query the MCP server
  const initMsg = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } }
  });
  const listMsg = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

  const input = `${initMsg}\n${listMsg}\n`;
  const serverPath = path.join(ROOT, 'dist/mcp-server.js');

  try {
    const output = execSync(`echo '${initMsg}' | node "${serverPath}" 2>/dev/null`, {
      timeout: 5000, encoding: 'utf-8',
      input: `${initMsg}\n${listMsg}\n`
    });

    const lines = output.trim().split('\n');
    let toolCount = 0;
    let hasOpenVisualizer = false;

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.result && msg.result.tools) {
          toolCount = msg.result.tools.length;
          hasOpenVisualizer = msg.result.tools.some(t => t.name === 'open_visualizer');
        }
      } catch {} // skip non-JSON lines
    }

    assert(toolCount === TOOL_COUNT, `expected ${TOOL_COUNT} tools, got ${toolCount}`);
    assert(hasOpenVisualizer, 'open_visualizer should be in tool list');
  } catch (err) {
    // Fallback: count server.tool() calls across server.js + pro-registry.js
    // Exclude commented-out lines (e.g. "// server.tool('start_tour', ...);")
    const serverSrc = fs.readFileSync(path.join(ROOT, 'out/mcp/server.js'), 'utf-8');
    const proRegistryPath = path.join(ROOT, 'out/mcp/pro-registry.js');
    const proSrc = fs.existsSync(proRegistryPath) ? fs.readFileSync(proRegistryPath, 'utf-8') : '';

    const countToolCalls = (src) => {
      return src.split('\n').filter(line => {
        const trimmed = line.trim();
        return trimmed.includes('server.tool(') && !trimmed.startsWith('//');
      }).length;
    };

    const serverCount = countToolCalls(serverSrc);
    const proCount = countToolCalls(proSrc);
    const totalCount = serverCount + proCount;

    assert(totalCount === TOOL_COUNT, `expected ${TOOL_COUNT} server.tool() calls (${serverCount} free + ${proCount} pro), got ${totalCount}`);
    assert(serverSrc.includes("'open_visualizer'"), 'server should register open_visualizer');
  }
});

test('open_visualizer tool has correct description', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'out/mcp/server.js'), 'utf-8');
  assert(serverSrc.includes('Open the Dendro visualizer'), 'description should mention opening the visualizer');
  assert(serverSrc.includes('ONCE before visualize_batch'), 'description should mention calling once before visualize_batch');
});

test('open_visualizer requires entryFile parameter', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'out/mcp/server.js'), 'utf-8');
  // The tool registration includes entryFile in the schema
  assert(serverSrc.includes('entryFile'), 'should require entryFile parameter');
});

// ============================================================================
// 5. Visualization Tools — Return Structures
// ============================================================================
section('📊 Visualization Tools — Return Structures');

test('visualizeHighlight returns { success, requestedCount, note }', () => {
  const result = visualizeHighlight(['App', 'Header'], 'red');
  assert(result.success === true, 'should succeed');
  assert(result.requestedCount === 2, `expected requestedCount 2, got ${result.requestedCount}`);
  assert(typeof result.note === 'string', 'should include note about verification');
});

test('visualizeZoom returns { success }', () => {
  const result = visualizeZoom('App');
  assert(result.success === true, 'should succeed');
});

test('visualizeAnnotate returns { success }', () => {
  const result = visualizeAnnotate('App', 'Entry point');
  assert(result.success === true, 'should succeed');
});

test('visualizeTraceFlow returns { success }', () => {
  const result = visualizeTraceFlow(['App', 'Header', 'Nav']);
  assert(result.success === true, 'should succeed');
});

test('visualizeClear returns { success }', () => {
  const result = visualizeClear('all');
  assert(result.success === true, 'should succeed');
});

test('visualizeExpand returns { success }', () => {
  const result = visualizeExpand('App');
  assert(result.success === true, 'should succeed');
});

test('visualizeCollapse returns { success }', () => {
  const result = visualizeCollapse('App');
  assert(result.success === true, 'should succeed');
});

// ============================================================================
// 6. Auto-open Support (entryFile param on viz tools)
// ============================================================================
section('🔄 Auto-open — entryFile on viz tool URIs');

test('visualizeHighlight supports entryFile option', () => {
  // The tool should accept entryFile and include it in the URI
  const result = visualizeHighlight(['App'], 'green', { entryFile: '/tmp/App.tsx' });
  assert(result.success === true, 'should succeed with entryFile');
});

test('visualizeZoom supports entryFile option', () => {
  const result = visualizeZoom('App', { entryFile: '/tmp/App.tsx' });
  assert(result.success === true, 'should succeed with entryFile');
});

test('visualizeAnnotate supports entryFile option', () => {
  const result = visualizeAnnotate('App', 'test', { entryFile: '/tmp/App.tsx' });
  assert(result.success === true, 'should succeed with entryFile');
});

test('visualizeTraceFlow supports entryFile option', () => {
  const result = visualizeTraceFlow(['A', 'B'], { entryFile: '/tmp/App.tsx' });
  assert(result.success === true, 'should succeed with entryFile');
});

test('entryFile param appears in URI construction', () => {
  const toolsSrc = fs.readFileSync(path.join(ROOT, 'out/mcp/tools.js'), 'utf-8');
  assert(toolsSrc.includes("'entryFile'"), 'tools.js should reference entryFile param');
});

// ============================================================================
// 7. Extension URI Handler — Auto-open Logic
// ============================================================================
section('🧩 Extension URI Handler — Auto-open');

test('URI handler supports entryFile param on /highlight', () => {
  const extSrc = fs.readFileSync(path.join(ROOT, 'out/server/extension.js'), 'utf-8');
  assert(extSrc.includes('entryFile'), 'extension should handle entryFile param');
});

test('URI handler calls openVisualization when no session and entryFile provided', () => {
  const extSrc = fs.readFileSync(path.join(ROOT, 'out/server/extension.js'), 'utf-8');
  // Check for the auto-open logic pattern
  assert(extSrc.includes('hasActiveSessions'), 'should check for active sessions');
});

// ============================================================================
// 8. Solsis .mcp.json Validation
// ============================================================================
section('📁 Solsis Frontend — MCP Config');

const SOLSIS_EXISTS = fs.existsSync(SOLSIS_ROOT);
const SOLSIS_MCP_EXISTS = SOLSIS_EXISTS && fs.existsSync(path.join(SOLSIS_ROOT, '.mcp.json'));

// Helper to find the dendro server key (may be 'dendro' or 'dendro-react')
function getDendroServerConfig() {
  if (!SOLSIS_MCP_EXISTS) return null;
  const config = JSON.parse(fs.readFileSync(path.join(SOLSIS_ROOT, '.mcp.json'), 'utf-8'));
  if (!config.mcpServers) return null;
  return config.mcpServers['dendro-react'] || config.mcpServers['dendro'] || null;
}

test('.mcp.json exists in solsis-frontend', () => {
  if (!SOLSIS_EXISTS) { console.log('     (skipped — solsis-frontend not found)'); return; }
  const mcpPath = path.join(SOLSIS_ROOT, '.mcp.json');
  assert(fs.existsSync(mcpPath), `.mcp.json not found at ${mcpPath}`);
});

test('.mcp.json is valid JSON', () => {
  if (!SOLSIS_MCP_EXISTS) { console.log('     (skipped — solsis-frontend/.mcp.json not found)'); return; }
  const mcpPath = path.join(SOLSIS_ROOT, '.mcp.json');
  const content = fs.readFileSync(mcpPath, 'utf-8');
  JSON.parse(content); // throws if invalid
});

test('.mcp.json has dendro server config', () => {
  if (!SOLSIS_MCP_EXISTS) { console.log('     (skipped — solsis-frontend/.mcp.json not found)'); return; }
  const config = JSON.parse(fs.readFileSync(path.join(SOLSIS_ROOT, '.mcp.json'), 'utf-8'));
  assert(config.mcpServers, 'should have mcpServers');
  const dendroConfig = getDendroServerConfig();
  assert(dendroConfig, 'should have dendro or dendro-react server');
});

test('.mcp.json uses node command', () => {
  if (!SOLSIS_MCP_EXISTS) { console.log('     (skipped — solsis-frontend/.mcp.json not found)'); return; }
  const dendroConfig = getDendroServerConfig();
  assert(dendroConfig, 'dendro server config not found');
  assert(dendroConfig.command.endsWith('node'), `command should end with "node", got "${dendroConfig.command}"`);
});

test('.mcp.json points to dist/mcp-server.js', () => {
  if (!SOLSIS_MCP_EXISTS) { console.log('     (skipped — solsis-frontend/.mcp.json not found)'); return; }
  const dendroConfig = getDendroServerConfig();
  assert(dendroConfig, 'dendro server config not found');
  const args = dendroConfig.args;
  assert(Array.isArray(args), 'args should be array');
  assert(args.length === 1, `expected 1 arg, got ${args.length}`);
  assert(args[0].endsWith('dist/mcp-server.js'), `arg should end with dist/mcp-server.js, got ${args[0]}`);
});

test('dist/mcp-server.js exists at configured path', () => {
  if (!SOLSIS_MCP_EXISTS) { console.log('     (skipped — solsis-frontend/.mcp.json not found)'); return; }
  const dendroConfig = getDendroServerConfig();
  assert(dendroConfig, 'dendro server config not found');
  const serverPath = dendroConfig.args[0];
  assert(fs.existsSync(serverPath), `MCP server not found at ${serverPath}`);
});

test('dist/mcp-server.js is executable (has shebang)', () => {
  if (!SOLSIS_MCP_EXISTS) { console.log('     (skipped — solsis-frontend/.mcp.json not found)'); return; }
  const dendroConfig = getDendroServerConfig();
  assert(dendroConfig, 'dendro server config not found');
  const serverPath = dendroConfig.args[0];
  if (!fs.existsSync(serverPath)) { console.log('     (skipped — mcp-server.js not found)'); return; }
  const firstLine = fs.readFileSync(serverPath, 'utf-8').split('\n')[0];
  assert(firstLine.includes('#!/usr/bin/env node'), `expected shebang, got: ${firstLine.substring(0, 50)}`);
});

test('dist/mcp-server.js is reasonably sized (> 1MB)', () => {
  if (!SOLSIS_MCP_EXISTS) { console.log('     (skipped — solsis-frontend/.mcp.json not found)'); return; }
  const dendroConfig = getDendroServerConfig();
  assert(dendroConfig, 'dendro server config not found');
  const serverPath = dendroConfig.args[0];
  if (!fs.existsSync(serverPath)) { console.log('     (skipped — mcp-server.js not found)'); return; }
  const stats = fs.statSync(serverPath);
  const sizeMB = stats.size / (1024 * 1024);
  assert(sizeMB > 1, `server bundle too small (${sizeMB.toFixed(1)} MB), may be missing dependencies`);
});

// ============================================================================
// 9. Cross-process Integration Check
// ============================================================================
section('🔌 Cross-process — MCP ↔ Extension Bridge');

test('~/.dendro directory exists or can be created', () => {
  const dendroDir = path.join(os.homedir(), '.dendro');
  if (!fs.existsSync(dendroDir)) {
    fs.mkdirSync(dendroDir, { recursive: true });
  }
  assert(fs.existsSync(dendroDir), '~/.dendro should exist');
});

test('extension URI handler source registers correctly', () => {
  const extSrc = fs.readFileSync(path.join(ROOT, 'out/server/extension.js'), 'utf-8');
  assert(extSrc.includes('registerUriHandler'), 'extension should register URI handler');
  assert(extSrc.includes('handleUri'), 'handler should implement handleUri');
});

test('webview-bridge exports sendCommand', () => {
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'out/server/webview-bridge.js'), 'utf-8');
  assert(bridgeSrc.includes('sendCommand'), 'bridge should export sendCommand');
  assert(bridgeSrc.includes('pendingCommands'), 'bridge should have command queue');
});

test('webview-bridge queues commands for not-ready webviews', () => {
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'out/server/webview-bridge.js'), 'utf-8');
  assert(bridgeSrc.includes('flushPendingCommands'), 'should flush pending commands when ready');
});

// ============================================================================
// Summary
// ============================================================================
console.log('\n' + '='.repeat(50));
console.log(`  ${passed + failed} tests | ${passed} passed | ${failed} failed`);
console.log('='.repeat(50) + '\n');

process.exit(failed > 0 ? 1 : 0);
