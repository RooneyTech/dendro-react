#!/usr/bin/env node
/**
 * Tier 2: MCP Server E2E Tests
 *
 * Spawns dist/mcp-server.js as a child process, connects as an MCP client
 * over stdio, and exercises every tool category against real fixtures.
 *
 * Usage:
 *   npm run build && node e2e/tier2-mcp/mcp-server.e2e.js
 */

const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(ROOT, 'src/test/fixtures/mcp-tools');
const CIRCULAR = path.join(ROOT, 'src/test/fixtures/circular-fixtures');
const NAV_FIXTURES = path.join(ROOT, 'src/test/fixtures/navigation');
const CONTEXT_FIXTURES = path.join(ROOT, 'src/test/fixtures/context');
const COMPLEXITY_FIXTURES = path.join(ROOT, 'src/test/fixtures/complexity-fixtures');
const HOOK_FIXTURES = path.join(ROOT, 'src/test/fixtures/hooks');
const PROPFLOW_FIXTURES = path.join(ROOT, 'src/test/fixtures/prop-flow');
const RERENDER_FIXTURES = path.join(ROOT, 'src/test/fixtures/rerender-risks');

const APP = path.join(FIXTURES, 'App.tsx');

// ── Test helpers ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function ok(condition, message) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m\u2713\x1b[0m ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  \x1b[31m\u2717\x1b[0m ${message}`);
  }
}

function eq(actual, expected, message) {
  ok(actual === expected, `${message} (expected: ${expected}, got: ${actual})`);
}

// ── MCP Client Setup ─────────────────────────────────────────────────

async function createClient() {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(ROOT, 'dist/mcp-server.js')],
    env: {
      ...process.env,
      DENDRO_WORKSPACE_ROOT: path.join(ROOT, 'src/test/fixtures'),
    },
    stderr: 'pipe',
  });

  const client = new Client(
    { name: 'dendro-e2e-test', version: '1.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport);
  return { client, transport };
}

async function callTool(client, toolName, args) {
  const result = await client.callTool({ name: toolName, arguments: args });
  const text = result.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text; // Workflow tools return plain text, not JSON
  }
}

// ── Test Sections ────────────────────────────────────────────────────

async function main() {
  console.log('\n\x1b[1m\x1b[36m=== Tier 2: MCP Server E2E Tests ===\x1b[0m\n');

  let client, transport;
  try {
    ({ client, transport } = await createClient());
  } catch (err) {
    console.error('Failed to start MCP server. Run "npm run build" first.');
    console.error(err.message);
    process.exit(1);
  }

  // ── Server Initialization ──────────────────────────────────────────

  console.log('\n\x1b[1mSection: Server Initialization\x1b[0m');

  const serverInfo = client.getServerVersion();
  ok(!!serverInfo, 'Server responded to initialize');
  ok(serverInfo?.name === 'dendro-react', `Server name is "dendro-react" (got: ${serverInfo?.name})`);
  ok(!!serverInfo?.version, `Server version is set: ${serverInfo?.version}`);

  // ── Tool Listing ───────────────────────────────────────────────────

  console.log('\n\x1b[1mSection: Tool Listing\x1b[0m');

  const toolsResult = await client.listTools();
  const tools = toolsResult.tools;
  ok(tools.length >= 50, `Tool count >= 50 (got: ${tools.length})`);

  const toolNames = tools.map(t => t.name);
  const expectedTools = [
    'get_component_tree', 'get_component_details', 'find_component_by_name',
    'find_components_by_type', 'detect_circular_deps', 'get_used_by',
    'get_prop_flow', 'get_hook_deps', 'get_navigation_structure',
    'get_context_map', 'get_screen_components', 'get_complexity_report',
    'get_rerender_risks', 'analyze_codebase', 'quick_audit', 'get_usage_guide',
    'open_visualizer', 'visualize_highlight', 'visualize_zoom',
    'visualize_annotate', 'visualize_trace_flow', 'visualize_clear',
    'visualize_batch', 'visualize_fit_all', 'visualize_expand',
    'visualize_collapse', 'visualize_analysis',
    'run_audit', 'run_sprint_check', 'run_ceo_briefing',
    'run_investor_scorecard', 'run_dev_onboarding', 'get_usage_stats',
  ];
  for (const name of expectedTools) {
    ok(toolNames.includes(name), `Tool "${name}" is registered`);
  }

  // ── Static Analysis Tools ──────────────────────────────────────────

  console.log('\n\x1b[1mSection: Static Analysis Tools\x1b[0m');

  // get_component_tree
  const tree = await callTool(client, 'get_component_tree', { entryFile: APP });
  ok(tree && tree.tree, 'get_component_tree returns a tree');
  ok(tree?.stats?.totalComponents >= 4, `Tree has >= 4 components (got: ${tree?.stats?.totalComponents})`);

  // get_component_details
  const details = await callTool(client, 'get_component_details', {
    filePath: path.join(FIXTURES, 'Header.tsx')
  });
  ok(details && details.file, `get_component_details returns file: ${details?.file}`);
  ok(details?.type === 'functional', `Header is functional (got: ${details?.type})`);

  // find_component_by_name
  const found = await callTool(client, 'find_component_by_name', {
    entryFile: APP, componentName: 'Header'
  });
  ok(found && found.matches?.length >= 1, `find_component_by_name found Header (${found?.matches?.length} matches)`);

  // find_components_by_type
  const byType = await callTool(client, 'find_components_by_type', {
    entryFile: APP, componentType: 'functional'
  });
  ok(byType && byType.components?.length >= 4, `Found >= 4 functional components (got: ${byType?.components?.length})`);

  // detect_circular_deps
  const circDeps = await callTool(client, 'detect_circular_deps', {
    rootPath: CIRCULAR
  });
  ok(circDeps && circDeps.circularDependencies?.length >= 1, `Detected >= 1 circular dep cycle (got: ${circDeps?.circularDependencies?.length})`);

  // get_complexity_report
  const complexity = await callTool(client, 'get_complexity_report', {
    rootPath: COMPLEXITY_FIXTURES, threshold: 0
  });
  ok(complexity && complexity.components?.length >= 1, `Complexity report has >= 1 component (got: ${complexity?.components?.length})`);

  // get_rerender_risks
  const risks = await callTool(client, 'get_rerender_risks', {
    rootPath: RERENDER_FIXTURES
  });
  ok(risks && (risks.files?.length >= 1 || risks.totalRisks >= 0), 'get_rerender_risks returns results');

  // get_hook_deps
  const hooks = await callTool(client, 'get_hook_deps', {
    filePath: path.join(FIXTURES, 'Header.tsx')
  });
  ok(hooks && hooks.hooks !== undefined, 'get_hook_deps returns hook data');

  // get_context_map
  const contextMap = await callTool(client, 'get_context_map', {
    rootPath: CONTEXT_FIXTURES
  });
  ok(contextMap && contextMap.contexts, 'get_context_map returns context data');

  // ── Composite Tools ────────────────────────────────────────────────

  console.log('\n\x1b[1mSection: Composite Tools\x1b[0m');

  // analyze_codebase
  const analysis = await callTool(client, 'analyze_codebase', { entryFile: APP });
  ok(analysis && analysis.tree, 'analyze_codebase returns tree');
  ok(analysis?.complexity, 'analyze_codebase returns complexity');
  ok(analysis?.context !== undefined, 'analyze_codebase returns context');

  // quick_audit
  const audit = await callTool(client, 'quick_audit', { rootPath: FIXTURES });
  ok(audit && audit.healthSummary, 'quick_audit returns healthSummary');
  ok(audit?.healthSummary?.grade, `quick_audit grade: ${audit?.healthSummary?.grade}`);

  // get_usage_guide
  const guide = await callTool(client, 'get_usage_guide', {});
  ok(guide && guide.overview, 'get_usage_guide returns overview');
  ok(guide?.categories, 'get_usage_guide returns categories');
  ok(guide?.categories?.workflow_tools, 'get_usage_guide includes workflow_tools category');

  // ── Workflow Tools ─────────────────────────────────────────────────

  console.log('\n\x1b[1mSection: Workflow Tools\x1b[0m');

  const workflowTools = [
    'run_audit', 'run_sprint_check', 'run_ceo_briefing',
    'run_investor_scorecard', 'run_dev_onboarding'
  ];
  for (const name of workflowTools) {
    const result = await callTool(client, name, { entryFile: APP });
    ok(typeof result === 'string' && result.length > 100, `${name} returns non-empty prompt (${typeof result === 'string' ? result.length : 0} chars)`);
  }

  // ── Visualization Tools (Shape Only) ───────────────────────────────

  console.log('\n\x1b[1mSection: Visualization Tools (shape validation)\x1b[0m');

  // open_visualizer — without VS Code, returns pending/error
  const vizResult = await callTool(client, 'open_visualizer', { entryFile: APP });
  ok(vizResult !== null, 'open_visualizer returns a response (even without VS Code)');

  // ── Error Handling ─────────────────────────────────────────────────

  console.log('\n\x1b[1mSection: Error Handling\x1b[0m');

  // Non-existent file
  const badFile = await callTool(client, 'get_component_tree', {
    entryFile: path.join(FIXTURES, 'DoesNotExist.tsx')
  });
  ok(badFile !== null, 'Non-existent file returns response (not crash)');

  // Path outside workspace
  const outsidePath = await callTool(client, 'get_component_tree', {
    entryFile: '/etc/passwd'
  });
  ok(outsidePath !== null, 'Path outside workspace returns response (not crash)');

  // ── Cleanup ────────────────────────────────────────────────────────

  try {
    await transport.close();
  } catch {
    // Server may have already exited
  }

  // ── Summary ────────────────────────────────────────────────────────

  console.log('\n\x1b[1m\x1b[36m=== Results ===\x1b[0m');
  console.log(`  Passed: \x1b[32m${passed}\x1b[0m`);
  console.log(`  Failed: \x1b[31m${failed}\x1b[0m`);
  if (failures.length > 0) {
    console.log('\n  Failures:');
    failures.forEach(f => console.log(`    - ${f}`));
  }
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('E2E test runner crashed:', err);
  process.exit(1);
});
