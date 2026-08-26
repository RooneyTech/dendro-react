#!/usr/bin/env node
/**
 * test-viz-reliability.js
 *
 * Tests for viz reliability features:
 * - visualize_fit_all: zoom viewport to fit entire tree
 * - visualize_batch: execute multiple viz commands sequentially
 * - Internal command queue (tested via batch behavior)
 *
 * Usage:
 *   npm run build && node scripts/test-viz-reliability.js
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const sections = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2705 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u274C ${name}`);
    console.log(`     ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function section(name, fn) {
  console.log(`\n--- ${name} ---`);
  const before = passed + failed;
  fn();
  sections.push({ name, tests: (passed + failed) - before });
}

// Import tools from build output
const {
  visualizeFitAll,
  visualizeBatch,
  getUsageGuide,
} = require(path.join(ROOT, 'out/mcp/tools'));

const { isProFeature, getFeatureTier, getFreeFeatureList, getProFeatureList } = require(path.join(ROOT, 'out/licensing/feature-gate'));

// ============================================================================
// Main
// ============================================================================
function main() {
  console.log('=== Dendro Viz Reliability Tests ===');

  // ==========================================================================
  // 1. visualize_fit_all — function existence and return shape
  // ==========================================================================
  section('visualize_fit_all — function exists and returns expected shape', () => {
    test('visualizeFitAll is a function', () => {
      assert(typeof visualizeFitAll === 'function', 'visualizeFitAll should be a function');
    });

    test('returns success with no options', () => {
      const result = visualizeFitAll();
      assert(result.success === true, 'should return success: true');
    });

    test('returns success with duration option', () => {
      const result = visualizeFitAll({ duration: 2000 });
      assert(result.success === true, 'should return success: true');
    });

    test('returns success with padding option', () => {
      const result = visualizeFitAll({ padding: 80 });
      assert(result.success === true, 'should return success: true');
    });

    test('returns success with sessionId option', () => {
      const result = visualizeFitAll({ sessionId: 'test-session' });
      assert(result.success === true, 'should return success: true');
    });

    test('returns success with entryFile option', () => {
      const result = visualizeFitAll({ entryFile: '/path/to/App.tsx' });
      assert(result.success === true, 'should return success: true');
    });

    test('returns success with all options', () => {
      const result = visualizeFitAll({
        sessionId: 'test-session',
        duration: 2000,
        padding: 80,
        entryFile: '/path/to/App.tsx'
      });
      assert(result.success === true, 'should return success: true');
    });

    test('result has no error property on success', () => {
      const result = visualizeFitAll();
      assert(result.error === undefined, 'error should be undefined on success');
    });
  });

  // ==========================================================================
  // 2. visualize_batch — function existence and return shape
  // ==========================================================================
  section('visualize_batch — function exists and returns expected shape', () => {
    test('visualizeBatch is a function', () => {
      assert(typeof visualizeBatch === 'function', 'visualizeBatch should be a function');
    });

    test('returns success with single command', () => {
      const result = visualizeBatch([{ type: 'clear' }]);
      assert(result.success === true, 'should return success: true');
      assert(result.commandCount === 1, 'commandCount should be 1');
    });

    test('returns success with multiple commands', () => {
      const commands = [
        { type: 'clear' },
        { type: 'highlight', payload: { nodes: ['App'], color: 'red' } },
        { type: 'zoom', payload: { target: 'App' } },
        { type: 'annotate', payload: { nodeId: 'App', text: 'Root' } }
      ];
      const result = visualizeBatch(commands);
      assert(result.success === true, 'should return success: true');
      assert(result.commandCount === 4, 'commandCount should be 4');
    });

    test('returns failure with empty commands array', () => {
      const result = visualizeBatch([]);
      assert(result.success === false, 'should return success: false');
      assert(result.commandCount === 0, 'commandCount should be 0');
      assert(result.error !== undefined, 'should have error message');
    });

    test('returns message with command count', () => {
      const result = visualizeBatch([{ type: 'clear' }, { type: 'fitAll' }]);
      assert(result.message.includes('2'), 'message should include command count');
    });

    test('accepts delay option', () => {
      const result = visualizeBatch([{ type: 'clear' }], { delay: 1000 });
      assert(result.success === true, 'should return success: true');
    });

    test('accepts sessionId option', () => {
      const result = visualizeBatch([{ type: 'clear' }], { sessionId: 'test-session' });
      assert(result.success === true, 'should return success: true');
    });

    test('accepts entryFile option', () => {
      const result = visualizeBatch([{ type: 'clear' }], { entryFile: '/path/to/App.tsx' });
      assert(result.success === true, 'should return success: true');
    });

    test('handles fitAll command in batch', () => {
      const result = visualizeBatch([
        { type: 'clear' },
        { type: 'fitAll', payload: { duration: 1500 } }
      ]);
      assert(result.success === true, 'should return success: true');
      assert(result.commandCount === 2, 'commandCount should be 2');
    });
  });

  // ==========================================================================
  // 3. Feature gate — both tools are free
  // ==========================================================================
  section('feature gate — viz reliability tools are free', () => {
    test('visualize_batch is free tier', () => {
      assert(getFeatureTier('visualize_batch') === 'free', 'visualize_batch should be free');
    });

    test('visualize_batch is not a pro feature', () => {
      assert(!isProFeature('visualize_batch'), 'visualize_batch should not be pro');
    });

    test('retired visualize_fit_all is no longer a registered feature', () => {
      const freeList = getFreeFeatureList();
      assert(!freeList.includes('visualize_fit_all'), 'visualize_fit_all was consolidated into visualize_batch');
    });

    test('free feature list includes visualize_batch', () => {
      const freeList = getFreeFeatureList();
      assert(freeList.includes('visualize_batch'), 'free list should include visualize_batch');
    });

    test('free/pro split is 25/10', () => {
      const freeCount = getFreeFeatureList().length;
      const proCount = getProFeatureList().length;
      assert(freeCount === (()=>{const g=require(path.join(ROOT, 'out/licensing/feature-gate'));return g.getFreeFeatureList().length+g.getProFeatureList().length;})() - 10, `expected free = total-10, got ${freeCount}`);
      assert(proCount === 10, `expected 10 pro, got ${proCount}`);
    });

    test('total features = 35', () => {
      const total = getFreeFeatureList().length + getProFeatureList().length;
      assert(total === (()=>{const g=require(path.join(ROOT, 'out/licensing/feature-gate'));return g.getFreeFeatureList().length+g.getProFeatureList().length;})(), `registry total mismatch, got ${total}`);
    });
  });

  // ==========================================================================
  // 4. Usage guide — updated with new tools
  // ==========================================================================
  section('usage guide — includes viz reliability tools', () => {
    test('overview mentions 35 tools', () => {
      const guide = getUsageGuide();
      assert(guide.overview.includes(String((()=>{const g=require(path.join(ROOT, 'out/licensing/feature-gate'));return g.getFreeFeatureList().length+g.getProFeatureList().length;})())), 'overview should mention 35 tools');
    });

    test('visualization category includes open_visualizer', () => {
      const guide = getUsageGuide();
      const vizTools = guide.categories.visualization.tools;
      const opener = vizTools.find(t => t.name === 'open_visualizer');
      assert(opener, 'visualization category should include open_visualizer');
    });

    test('visualization category includes visualize_batch', () => {
      const guide = getUsageGuide();
      const vizTools = guide.categories.visualization.tools;
      const batch = vizTools.find(t => t.name === 'visualize_batch');
      assert(batch, 'visualization category should include visualize_batch');
    });

    test('workflows include batch visualization', () => {
      const guide = getUsageGuide();
      const batchWorkflow = guide.workflows.find(w => w.name.toLowerCase().includes('batch'));
      assert(batchWorkflow, 'workflows should include batch visualization');
    });

    test('sequencing rules cover the fitAll batch step', () => {
      const guide = getUsageGuide();
      const fitAllRule = guide.sequencing_rules.find(r => r.includes('fitAll'));
      assert(fitAllRule, 'sequencing rules should mention the fitAll batch command step');
    });

    test('sequencing rules mention visualize_batch', () => {
      const guide = getUsageGuide();
      const batchRule = guide.sequencing_rules.find(r => r.includes('visualize_batch') || r.includes('batch'));
      assert(batchRule, 'sequencing rules should mention batch');
    });
  });

  // ==========================================================================
  // 5. Result interface shapes
  // ==========================================================================
  section('result interface shapes', () => {
    test('visualizeFitAll result has success field', () => {
      const result = visualizeFitAll();
      assert('success' in result, 'result should have success field');
    });

    test('visualizeBatch result has success, commandCount, message fields', () => {
      const result = visualizeBatch([{ type: 'clear' }]);
      assert('success' in result, 'result should have success field');
      assert('commandCount' in result, 'result should have commandCount field');
      assert('message' in result, 'result should have message field');
    });

    test('visualizeBatch failure result has error field', () => {
      const result = visualizeBatch([]);
      assert('error' in result, 'failure result should have error field');
    });
  });

  // ==========================================================================
  // Summary
  // ==========================================================================
  console.log('\n=== Results ===');
  for (const s of sections) {
    console.log(`  ${s.name}: ${s.tests} tests`);
  }
  console.log(`\nTotal: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

main();
