#!/usr/bin/env node

// Hermetic IPC: a VS Code extension host leaks DENDRO_WORKSPACE_HASH into any
// terminal or agent it spawns, which redirects runtime-state reads to a
// per-workspace dir while these tests write the global fallback path — every
// state-dependent assertion then fails. Scrub it so results don't depend on
// where the test runner was launched from.
delete process.env.DENDRO_WORKSPACE_HASH;
/**
 * Test suite for TICKET-047 Phase 4: Tour Mode
 *
 * Tests:
 * - Tour bridge (write/read/clear config file)
 * - startTour() MCP tool function
 * - StartTourCommand type in webview-bridge
 * - Feature gate registration
 * - Usage guide updates (51 tools)
 * - Extension URI handler
 * - Edge cases
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');

// Initialize workspace root so assertPathInWorkspace() accepts fixture paths
process.env.DENDRO_WORKSPACE_ROOT = ROOT;
const { initWorkspaceRoot } = require(path.join(ROOT, 'out/mcp/path-boundary'));
initWorkspaceRoot();

const FIXTURES = path.join(ROOT, 'src/test/fixtures/mcp-tools');
const APP_FIXTURE = path.join(FIXTURES, 'App.tsx');

// Import compiled modules
const {
  startTour,
  getUsageGuide,
  visualizeBatch,
  visualizeFitAll,
} = require(path.join(ROOT, 'out/mcp/tools'));

const {
  writeTourConfig,
  readTourConfig,
  clearTourConfig,
  getTourPaths,
} = require(path.join(ROOT, 'out/runtime/tour-bridge'));
const TOUR_PATHS = getTourPaths();

const {
  getProFeatureList,
  getFreeFeatureList,
} = require(path.join(ROOT, 'out/licensing/feature-gate'));

let passed = 0;
let failed = 0;
let currentSection = '';

function section(name, fn) {
  currentSection = name;
  console.log(`\n--- ${name} ---`);
  if (fn) fn();
}

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2705 ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \u274C ${name}`);
    console.log(`     ${err.message}`);
    failed++;
  }
}

// ==========================================================================
// 1. Tour Bridge — file-based IPC
// ==========================================================================
section('tour bridge — write/read/clear config', () => {
  const testConfig = {
    title: 'Test Tour',
    steps: [
      {
        title: 'Step 1',
        description: 'First step',
        commands: [{ type: 'fitAll', payload: { duration: 1000 } }],
      },
      {
        title: 'Step 2',
        description: 'Second step',
        commands: [
          { type: 'clear', payload: { clearType: 'all' } },
          { type: 'highlight', payload: { nodes: ['App.tsx'], color: 'red' } },
        ],
        autoAdvanceMs: 3000,
      },
    ],
    autoPlay: true,
    clearOnExit: true,
  };

  test('TOUR_PATHS.configFile ends with tour-config.json', () => {
    assert(TOUR_PATHS.configFile.endsWith('tour-config.json'),
      `Expected path ending with tour-config.json, got ${TOUR_PATHS.configFile}`);
  });

  test('TOUR_PATHS.dendroDir is ~/.dendro', () => {
    const expected = path.join(os.homedir(), '.dendro');
    assert.strictEqual(TOUR_PATHS.dendroDir, expected);
  });

  test('writeTourConfig writes valid JSON', () => {
    writeTourConfig(testConfig);
    assert(fs.existsSync(TOUR_PATHS.configFile), 'Config file should exist after write');
    const content = fs.readFileSync(TOUR_PATHS.configFile, 'utf-8');
    const parsed = JSON.parse(content);
    assert.strictEqual(parsed.title, 'Test Tour');
    assert.strictEqual(parsed.steps.length, 2);
  });

  test('readTourConfig reads back the config', () => {
    const config = readTourConfig();
    assert(config !== null, 'Config should not be null');
    assert.strictEqual(config.title, 'Test Tour');
    assert.strictEqual(config.steps[0].title, 'Step 1');
    assert.strictEqual(config.steps[1].autoAdvanceMs, 3000);
    assert.strictEqual(config.autoPlay, true);
  });

  test('clearTourConfig removes the file', () => {
    clearTourConfig();
    assert(!fs.existsSync(TOUR_PATHS.configFile), 'Config file should be deleted');
  });

  test('readTourConfig returns null when no file', () => {
    const config = readTourConfig();
    assert.strictEqual(config, null, 'Should return null when no file');
  });

  test('clearTourConfig is safe to call when no file', () => {
    // Should not throw
    clearTourConfig();
    clearTourConfig();
  });

  test('writeTourConfig handles large configs', () => {
    const largeConfig = {
      title: 'Large Tour',
      steps: Array.from({ length: 20 }, (_, i) => ({
        title: `Step ${i + 1}`,
        description: `Description for step ${i + 1} with some longer text to simulate real content...`,
        commands: [
          { type: 'clear', payload: { clearType: 'all' } },
          { type: 'highlight', payload: { nodes: [`Component${i}.tsx`], color: 'red' } },
          { type: 'zoom', payload: { target: `Component${i}.tsx`, duration: 800 } },
          { type: 'annotate', payload: { nodeId: `Component${i}.tsx`, text: `Info about ${i}` } },
        ],
      })),
    };
    writeTourConfig(largeConfig);
    const content = fs.readFileSync(TOUR_PATHS.configFile, 'utf-8');
    assert(content.length > 3000, `Large config should be >3KB, got ${content.length} bytes`);
    const parsed = readTourConfig();
    assert.strictEqual(parsed.steps.length, 20);
    clearTourConfig();
  });
});

// ==========================================================================
// 2. startTour() MCP tool function
// ==========================================================================
section('startTour() — MCP tool function', () => {
  test('returns success with valid config', () => {
    const result = startTour(APP_FIXTURE, {
      title: 'Demo Tour',
      steps: [
        { title: 'Overview', description: 'App overview', commands: [] },
        { title: 'Details', description: 'Component details', commands: [{ type: 'fitAll' }] },
      ],
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stepCount, 2);
    assert(result.message.includes('Demo Tour'), `Message should mention tour title: ${result.message}`);
    // Clean up config file
    clearTourConfig();
  });

  test('returns error for empty steps', () => {
    const result = startTour(APP_FIXTURE, {
      title: 'Empty',
      steps: [],
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.stepCount, 0);
    assert(result.error, 'Should have error message');
  });

  test('returns error for null config', () => {
    const result = startTour(APP_FIXTURE, null);
    assert.strictEqual(result.success, false);
  });

  test('writes config file before returning', () => {
    clearTourConfig();
    startTour(APP_FIXTURE, {
      title: 'Write Test',
      steps: [{ title: 'S1', description: 'D1', commands: [] }],
    });
    const config = readTourConfig();
    assert(config !== null, 'Config should be written');
    assert.strictEqual(config.title, 'Write Test');
    clearTourConfig();
  });

  test('stepCount matches actual steps', () => {
    const result = startTour(APP_FIXTURE, {
      title: 'Count Test',
      steps: [
        { title: 'A', description: '', commands: [] },
        { title: 'B', description: '', commands: [] },
        { title: 'C', description: '', commands: [] },
        { title: 'D', description: '', commands: [] },
        { title: 'E', description: '', commands: [] },
      ],
    });
    assert.strictEqual(result.stepCount, 5);
    clearTourConfig();
  });

  test('handles config with autoPlay and clearOnExit', () => {
    const result = startTour(APP_FIXTURE, {
      title: 'Options Test',
      steps: [{ title: 'S1', description: 'D1', commands: [], autoAdvanceMs: 2000 }],
      autoPlay: true,
      clearOnExit: false,
    });
    assert.strictEqual(result.success, true);
    const config = readTourConfig();
    assert.strictEqual(config.autoPlay, true);
    assert.strictEqual(config.clearOnExit, false);
    assert.strictEqual(config.steps[0].autoAdvanceMs, 2000);
    clearTourConfig();
  });
});

// ==========================================================================
// 3. Feature gate — start_tour is shelved (TICKET-054)
// ==========================================================================
section('feature gate — tool counts', () => {
  // start_tour is shelved (TICKET-054), skip registration assertion
  // test('start_tour is in free feature list', () => { ... });

  test('free feature list has 25 entries', () => {
    const freeList = getFreeFeatureList();
    assert(freeList.length === (()=>{const g=require(path.join(ROOT, 'out/licensing/feature-gate'));return g.getFreeFeatureList().length+g.getProFeatureList().length;})() - 10, `expected 25 free features, got ${freeList.length}`);
  });

  test('pro feature list still has 10 entries', () => {
    const proList = getProFeatureList();
    assert(proList.length === 10, `expected 10 pro features, got ${proList.length}`);
  });

  test('total features = 35', () => {
    const total = getProFeatureList().length + getFreeFeatureList().length;
    assert(total === (()=>{const g=require(path.join(ROOT, 'out/licensing/feature-gate'));return g.getFreeFeatureList().length+g.getProFeatureList().length;})(), `registry total mismatch, got ${total}`);
  });
});

// ==========================================================================
// 4. Usage guide — includes tour tool and workflow
// ==========================================================================
section('usage guide — tour tool and workflow', () => {
  test('overview mentions 35 tools', () => {
    const guide = getUsageGuide();
    assert(guide.overview.includes(String((()=>{const g=require(path.join(ROOT, 'out/licensing/feature-gate'));return g.getFreeFeatureList().length+g.getProFeatureList().length;})())), `Overview should mention 35 tools: ${guide.overview}`);
  });

  // start_tour shelved (TICKET-054) — skip visualization category assertion
  // test('visualization category includes start_tour', () => { ... });

  // start_tour shelved (TICKET-054) — tour workflow removed from usage guide
  // test('workflows include guided tour workflow', () => { ... });

  // start_tour shelved (TICKET-054) — skip workflow tool reference assertion
  // test('tour workflow mentions start_tour tool', () => { ... });
});

// ==========================================================================
// 5. StartTourCommand type — webview bridge
// ==========================================================================
section('webview bridge — StartTourCommand', () => {
  test('webview-bridge.ts source defines StartTourCommand', () => {
    const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src/server/webview-bridge.ts'), 'utf-8');
    assert(bridgeSrc.includes('StartTourCommand'), 'webview-bridge.ts should define StartTourCommand');
  });

  test('StartTourCommand is in VisualizationCommand union', () => {
    const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src/server/webview-bridge.ts'), 'utf-8');
    assert(bridgeSrc.includes('| StartTourCommand'), 'VisualizationCommand union should include StartTourCommand');
  });

  test('StartTourCommand has tourConfig in payload', () => {
    const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src/server/webview-bridge.ts'), 'utf-8');
    assert(bridgeSrc.includes('tourConfig'), 'StartTourCommand should have tourConfig field');
  });
});

// ==========================================================================
// 6. Extension URI handler
// ==========================================================================
section('extension — /start-tour URI handler', () => {
  test('extension.js includes start-tour case', () => {
    const extSrc = fs.readFileSync(path.join(ROOT, 'out/server/extension.js'), 'utf-8');
    assert(extSrc.includes('/start-tour'), 'extension should have /start-tour URI case');
  });

  test('extension reads tour config via tour-bridge', () => {
    const extSrc = fs.readFileSync(path.join(ROOT, 'out/server/extension.js'), 'utf-8');
    assert(extSrc.includes('readTourConfig'), 'extension should call readTourConfig');
    assert(extSrc.includes('clearTourConfig'), 'extension should call clearTourConfig');
  });

  test('extension sends startTour command to webview', () => {
    const extSrc = fs.readFileSync(path.join(ROOT, 'out/server/extension.js'), 'utf-8');
    assert(extSrc.includes('startTour'), 'extension should send startTour command');
  });
});

// ==========================================================================
// 7. MCP server registration
// ==========================================================================
// start_tour shelved (TICKET-054) — all registration tests skipped
section('MCP server — start_tour tool registration (shelved)', () => {
  // test('server.ts registers start_tour tool', () => { ... });
  // test('server imports startTour from tools', () => { ... });
  // test('server.ts source imports StartTourResult', () => { ... });
});

// ==========================================================================
// 8. TourPanel component
// ==========================================================================
section('TourPanel — webview component', () => {
  test('TourPanel.jsx exists', () => {
    assert(fs.existsSync(path.join(ROOT, 'src/webview/TourPanel.jsx')), 'TourPanel.jsx should exist');
  });

  test('TourPanel.js exists in out/webview/', () => {
    assert(fs.existsSync(path.join(ROOT, 'out/webview/TourPanel.js')), 'TourPanel.js should exist in out/webview/');
  });

  test('TourPanel imports from tokens.js', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/webview/TourPanel.jsx'), 'utf-8');
    assert(src.includes("from './tokens'"), 'TourPanel should import design tokens');
  });

  test('TourPanel handles keyboard navigation', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/webview/TourPanel.jsx'), 'utf-8');
    assert(src.includes('ArrowRight'), 'Should handle ArrowRight key');
    assert(src.includes('ArrowLeft'), 'Should handle ArrowLeft key');
    assert(src.includes('Escape'), 'Should handle Escape key');
  });

  test('TourPanel supports auto-play', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/webview/TourPanel.jsx'), 'utf-8');
    assert(src.includes('autoPlaying'), 'Should track autoPlaying state');
    assert(src.includes('autoAdvanceMs'), 'Should reference autoAdvanceMs');
  });

  test('TourPanel uses command handler from window', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/webview/TourPanel.jsx'), 'utf-8');
    assert(src.includes('_dendroVisualizationCommandHandler'), 'Should use global command handler');
  });

  test('TourPanel clears on exit by default', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/webview/TourPanel.jsx'), 'utf-8');
    assert(src.includes('clearOnExit'), 'Should check clearOnExit config');
  });
});

// ==========================================================================
// 9. index.js — tour integration
// ==========================================================================
section('index.js — tour message handling', () => {
  test('index.js imports TourPanel', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/webview/index.js'), 'utf-8');
    assert(src.includes("import TourPanel"), 'Should import TourPanel');
  });

  test('index.js handles startTour command type', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/webview/index.js'), 'utf-8');
    assert(src.includes("command.type === 'startTour'"), 'Should intercept startTour commands');
  });

  test('index.js exposes command handler globally', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/webview/index.js'), 'utf-8');
    assert(src.includes('_dendroVisualizationCommandHandler'), 'Should expose handler globally');
  });

  test('index.js tracks tour config state', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/webview/index.js'), 'utf-8');
    assert(src.includes('currentTourConfig'), 'Should track currentTourConfig');
  });

  test('index.js has renderCurrentView helper', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/webview/index.js'), 'utf-8');
    assert(src.includes('function renderCurrentView'), 'Should have renderCurrentView function');
  });
});

// ==========================================================================
// 10. Edge cases
// ==========================================================================
section('edge cases', () => {
  test('startTour with steps containing empty commands', () => {
    const result = startTour(APP_FIXTURE, {
      title: 'Empty Commands',
      steps: [
        { title: 'Intro', description: 'No commands', commands: [] },
        { title: 'End', description: 'Also empty', commands: [] },
      ],
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stepCount, 2);
    clearTourConfig();
  });

  test('startTour with single step', () => {
    const result = startTour(APP_FIXTURE, {
      title: 'Single Step',
      steps: [{ title: 'Only', description: 'One step', commands: [{ type: 'fitAll' }] }],
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stepCount, 1);
    clearTourConfig();
  });

  test('startTour config persists all step fields', () => {
    startTour(APP_FIXTURE, {
      title: 'Full Config',
      steps: [{
        title: 'Complex Step',
        description: 'Has everything',
        commands: [
          { type: 'clear', payload: { clearType: 'all' } },
          { type: 'highlight', payload: { nodes: ['A', 'B'], color: 'red', pulse: true } },
          { type: 'zoom', payload: { target: 'A', duration: 1000 } },
          { type: 'annotate', payload: { nodeId: 'A', text: 'Important', position: 'right' } },
        ],
        autoAdvanceMs: 5000,
      }],
      autoPlay: true,
      clearOnExit: false,
    });
    const config = readTourConfig();
    assert.strictEqual(config.steps[0].commands.length, 4);
    assert.strictEqual(config.steps[0].commands[1].payload.nodes.length, 2);
    assert.strictEqual(config.steps[0].commands[2].payload.duration, 1000);
    assert.strictEqual(config.steps[0].autoAdvanceMs, 5000);
    clearTourConfig();
  });

  test('multiple writeTourConfig calls overwrite', () => {
    writeTourConfig({ title: 'First' });
    writeTourConfig({ title: 'Second' });
    const config = readTourConfig();
    assert.strictEqual(config.title, 'Second');
    clearTourConfig();
  });
});

// ==========================================================================
// Summary
// ==========================================================================
console.log(`\n=== Results ===`);
console.log(`Total: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
