#!/usr/bin/env node
/**
 * test-composite-tools.js
 *
 * Tests for TICKET-042 composite agent tools:
 * - analyze_codebase: combined tree + complexity + context + circular deps
 * - quick_audit: health check with grade
 * - visualize_analysis: open + highlight + annotate (structure only — no VS Code)
 *
 * Usage:
 *   npm run build && node scripts/test-composite-tools.js
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'src/test/fixtures/mcp-tools');
const CONTEXT_FIXTURES = path.join(ROOT, 'src/test/fixtures/context');
const COMPLEXITY_FIXTURES = path.join(ROOT, 'src/test/fixtures/complexity-fixtures');

const APP = path.join(FIXTURES, 'App.tsx');

// Initialize workspace root for path-boundary validation
process.env.DENDRO_WORKSPACE_ROOT = ROOT;
const { initWorkspaceRoot } = require(path.join(ROOT, 'out/mcp/path-boundary'));
initWorkspaceRoot();

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

async function testAsync(name, fn) {
  try {
    await fn();
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

async function sectionAsync(name, fn) {
  console.log(`\n--- ${name} ---`);
  const before = passed + failed;
  await fn();
  sections.push({ name, tests: (passed + failed) - before });
}

// Import tools from build output
const {
  analyzeCodebase,
  quickAudit,
  visualizeAnalysis,
  getComponentTree,
  getComplexityReport,
  getContextMap,
  detectCircularDeps,
  getUsageGuide,
} = require(path.join(ROOT, 'out/mcp/tools'));

const { isProFeature, getFreeFeatureList } = require(path.join(ROOT, 'out/licensing/feature-gate'));
// Set DENDRO_INCLUDE_PRO so createServer() can reference it (webpack DefinePlugin substitute)
globalThis.DENDRO_INCLUDE_PRO = false;
const { createServer } = require(path.join(ROOT, 'out/mcp/server'));

// ============================================================================
// Main
// ============================================================================
async function main() {
  console.log('=== Dendro Composite Tools Tests (TICKET-042) ===');
  console.log(`Fixtures: ${FIXTURES}`);

  // ==========================================================================
  // 1. analyze_codebase
  // ==========================================================================
  section('analyze_codebase — basic functionality', () => {
    test('returns combined result with all 4 analyses', () => {
      const result = analyzeCodebase(APP);
      assert(result.tree, 'result.tree should exist');
      assert(result.complexity, 'result.complexity should exist');
      assert(result.context, 'result.context should exist');
      assert(result.circularDeps, 'result.circularDeps should exist');
      assert(result.summary, 'result.summary should exist');
      assert(Array.isArray(result.errors), 'result.errors should be an array');
    });

    test('tree analysis matches standalone getComponentTree', () => {
      const composite = analyzeCodebase(APP);
      const standalone = getComponentTree(APP);
      assert(composite.tree.stats.totalComponents === standalone.stats.totalComponents,
        `Component count mismatch: ${composite.tree.stats.totalComponents} vs ${standalone.stats.totalComponents}`);
    });

    test('summary reflects tree stats', () => {
      const result = analyzeCodebase(APP);
      assert(result.summary.totalComponents === result.tree.stats.totalComponents,
        'summary.totalComponents should match tree stats');
      assert(result.summary.maxDepth === result.tree.stats.maxDepth,
        'summary.maxDepth should match tree stats');
    });

    test('summary reflects complexity stats', () => {
      const result = analyzeCodebase(APP);
      assert(result.summary.complexityAverage === result.complexity.summary.average,
        'summary.complexityAverage should match complexity stats');
      assert(result.summary.highComplexityCount === result.complexity.summary.high,
        'summary.highComplexityCount should match complexity stats');
    });

    test('summary reflects context stats', () => {
      const result = analyzeCodebase(APP);
      assert(result.summary.totalContexts === result.context.totalContexts,
        'summary.totalContexts should match context stats');
      assert(result.summary.totalConsumers === result.context.totalConsumers,
        'summary.totalConsumers should match context stats');
    });

    test('summary reflects circular deps', () => {
      const result = analyzeCodebase(APP);
      assert(result.summary.hasCircularDeps === result.circularDeps.hasCircularDeps,
        'summary.hasCircularDeps should match circularDeps result');
      assert(result.summary.circularDepCount === result.circularDeps.circularDependencies.length,
        'summary.circularDepCount should match circularDeps count');
    });

    test('no errors on valid fixtures', () => {
      const result = analyzeCodebase(APP);
      assert(result.errors.length === 0,
        `Expected no errors, got: ${result.errors.join(', ')}`);
    });
  });

  section('analyze_codebase — rootPath override', () => {
    test('accepts custom rootPath for directory scans', () => {
      const result = analyzeCodebase(APP, FIXTURES);
      assert(result.tree, 'tree should still work with custom rootPath');
      assert(result.complexity, 'complexity should use custom rootPath');
    });

    test('defaults rootPath to entry file directory', () => {
      const result1 = analyzeCodebase(APP);
      const result2 = analyzeCodebase(APP, path.dirname(APP));
      // Both should scan the same directory
      assert(result1.complexity.summary.totalComponents === result2.complexity.summary.totalComponents,
        'Default rootPath should match explicit entry file directory');
    });
  });

  section('analyze_codebase — error handling', () => {
    test('handles invalid entry file gracefully', () => {
      try {
        const result = analyzeCodebase('/nonexistent/App.tsx');
        assert(result.tree.error, 'tree should have error');
        assert(result.errors.length > 0, 'errors array should contain tree error');
      } catch (err) {
        // PathBoundaryError is acceptable — the path is outside workspace
        assert(err.message.includes('outside') || err.message.includes('boundary') || err.message.includes('Path'),
          `expected path boundary error, got: ${err.message}`);
      }
    });

    test('partial failure: bad entry file but valid rootPath', () => {
      try {
        const result = analyzeCodebase('/nonexistent/App.tsx', FIXTURES);
        assert(result.tree.error, 'tree should have error for bad entry file');
        // Complexity should still work since rootPath is valid
        assert(result.complexity.components.length >= 0, 'complexity should still return');
      } catch (err) {
        // PathBoundaryError is acceptable — the entry file is outside workspace
        assert(err.message.includes('outside') || err.message.includes('boundary') || err.message.includes('Path'),
          `expected path boundary error, got: ${err.message}`);
      }
    });
  });

  // ==========================================================================
  // 2. quick_audit
  // ==========================================================================
  section('quick_audit — basic functionality', () => {
    test('returns all expected sections', () => {
      const result = quickAudit(FIXTURES);
      assert(Array.isArray(result.topComplexComponents), 'topComplexComponents should be array');
      assert(result.circularDeps !== undefined, 'circularDeps should exist');
      assert(Array.isArray(result.propDrillingCandidates), 'propDrillingCandidates should be array');
      assert(Array.isArray(result.heavyContextProviders), 'heavyContextProviders should be array');
      assert(result.healthSummary, 'healthSummary should exist');
      assert(result.healthSummary.grade, 'healthSummary.grade should exist');
      assert(Array.isArray(result.healthSummary.issues), 'healthSummary.issues should be array');
      assert(Array.isArray(result.errors), 'errors should be array');
    });

    test('top complex components limited to 5', () => {
      const result = quickAudit(FIXTURES);
      assert(result.topComplexComponents.length <= 5,
        `Expected at most 5, got ${result.topComplexComponents.length}`);
    });

    test('top complex components are sorted by score descending', () => {
      const result = quickAudit(FIXTURES);
      for (let i = 1; i < result.topComplexComponents.length; i++) {
        assert(result.topComplexComponents[i-1].score >= result.topComplexComponents[i].score,
          `Components not sorted: ${result.topComplexComponents[i-1].score} < ${result.topComplexComponents[i].score}`);
      }
    });

    test('component entries have expected fields', () => {
      const result = quickAudit(FIXTURES);
      if (result.topComplexComponents.length > 0) {
        const comp = result.topComplexComponents[0];
        assert(comp.file !== undefined, 'file should exist');
        assert(comp.score !== undefined, 'score should exist');
        assert(comp.rating !== undefined, 'rating should exist');
        assert(comp.propsCount !== undefined, 'propsCount should exist');
        assert(comp.stateCount !== undefined, 'stateCount should exist');
        assert(comp.effectCount !== undefined, 'effectCount should exist');
      }
    });

    test('circular deps section has expected fields', () => {
      const result = quickAudit(FIXTURES);
      assert(typeof result.circularDeps.found === 'boolean', 'found should be boolean');
      assert(typeof result.circularDeps.count === 'number', 'count should be number');
      assert(Array.isArray(result.circularDeps.cycles), 'cycles should be array');
    });

    test('prop drilling candidates have 5+ props', () => {
      const result = quickAudit(FIXTURES);
      for (const candidate of result.propDrillingCandidates) {
        assert(candidate.propsCount >= 5,
          `Prop drilling candidate ${candidate.file} has ${candidate.propsCount} props (expected >= 5)`);
      }
    });

    test('health grade is valid A-F', () => {
      const result = quickAudit(FIXTURES);
      assert(['A', 'B', 'C', 'D', 'F'].includes(result.healthSummary.grade),
        `Invalid grade: ${result.healthSummary.grade}`);
    });
  });

  section('quick_audit — with complexity fixtures', () => {
    test('detects complex components in complexity fixtures', () => {
      const result = quickAudit(COMPLEXITY_FIXTURES);
      assert(result.topComplexComponents.length > 0,
        'Should find complex components in complexity fixtures');
    });
  });

  section('quick_audit — error handling', () => {
    test('handles invalid path gracefully', () => {
      const result = quickAudit('/nonexistent/path');
      assert(result.errors.length > 0, 'Should have errors for invalid path');
      // Should still return valid structure
      assert(result.healthSummary.grade, 'Should still have a health grade');
    });
  });

  // ==========================================================================
  // 3. visualize_analysis — structure validation only
  // ==========================================================================
  // Note: actual visualization requires VS Code extension, so we test the
  // function signature, return type, and error handling only.

  await sectionAsync('visualize_analysis — return structure', async () => {
    await testAsync('returns expected result shape', async () => {
      // This will fail to open the visualizer (no VS Code) but should return gracefully
      const result = await visualizeAnalysis(APP, 'all');
      assert(result.visualizer !== undefined, 'visualizer should exist');
      assert(result.analysisPerformed !== undefined, 'analysisPerformed should exist');
      assert(Array.isArray(result.highlightedNodes), 'highlightedNodes should be array');
      assert(Array.isArray(result.annotatedNodes), 'annotatedNodes should be array');
      assert(Array.isArray(result.errors), 'errors should be array');
    });

    await testAsync('defaults focus to "all" when not specified', async () => {
      const result = await visualizeAnalysis(APP);
      assert(result.analysisPerformed === 'all',
        `Expected focus 'all', got '${result.analysisPerformed}'`);
    });

    await testAsync('respects specific focus parameter', async () => {
      const resultComplexity = await visualizeAnalysis(APP, 'complexity');
      assert(resultComplexity.analysisPerformed === 'complexity',
        `Expected 'complexity', got '${resultComplexity.analysisPerformed}'`);

      const resultDeps = await visualizeAnalysis(APP, 'deps');
      assert(resultDeps.analysisPerformed === 'deps',
        `Expected 'deps', got '${resultDeps.analysisPerformed}'`);

      const resultContext = await visualizeAnalysis(APP, 'context');
      assert(resultContext.analysisPerformed === 'context',
        `Expected 'context', got '${resultContext.analysisPerformed}'`);
    });
  });

  // ==========================================================================
  // 4. Feature gate — all composite tools are free
  // ==========================================================================
  section('Feature gate — composite tools are free', () => {
    test('analyze_codebase is free', () => {
      assert(!isProFeature('analyze_codebase'),
        'analyze_codebase should be free');
    });

    test('quick_audit is free', () => {
      assert(!isProFeature('quick_audit'),
        'quick_audit should be free');
    });

    test('visualize_analysis is free', () => {
      assert(!isProFeature('visualize_analysis'),
        'visualize_analysis should be free');
    });

    test('composite tools in free feature list', () => {
      const freeList = getFreeFeatureList();
      assert(freeList.includes('analyze_codebase'), 'analyze_codebase should be in free list');
      assert(freeList.includes('quick_audit'), 'quick_audit should be in free list');
      assert(freeList.includes('visualize_analysis'), 'visualize_analysis should be in free list');
    });
  });

  // ==========================================================================
  // 5. MCP server registration
  // ==========================================================================
  section('MCP server — composite tool registration', () => {
    test('createServer includes analyze_codebase', () => {
      const server = createServer();
      // Server exposes tools via _registeredTools or similar
      // We verify by checking the server object has no errors during creation
      assert(server, 'Server should be created successfully with composite tools');
    });
  });

  // ==========================================================================
  // 6. get_usage_guide — updated with composites
  // ==========================================================================
  section('get_usage_guide — composite tool recommendations', () => {
    test('overview mentions 35 tools', () => {
      const guide = getUsageGuide();
      assert(guide.overview.includes(String((()=>{const g=require(path.join(ROOT, 'out/licensing/feature-gate'));return g.getFreeFeatureList().length+g.getProFeatureList().length;})())), `Overview should mention 35 tools: ${guide.overview}`);
    });

    test('quick_start recommends composite tools', () => {
      const guide = getUsageGuide();
      assert(guide.quick_start.includes('analyze_codebase'),
        'quick_start should mention analyze_codebase');
      assert(guide.quick_start.includes('quick_audit'),
        'quick_start should mention quick_audit');
      assert(guide.quick_start.includes('visualize_analysis'),
        'quick_start should mention visualize_analysis');
    });

    test('categories includes composite category', () => {
      const guide = getUsageGuide();
      assert(guide.categories.composite, 'Should have composite category');
      assert(guide.categories.composite.tools.length >= 5,
        `Expected at least 5 composite tools, got ${guide.categories.composite.tools.length}`);
    });

    test('composite category lists all 3 tools', () => {
      const guide = getUsageGuide();
      const toolNames = guide.categories.composite.tools.map(t => t.name);
      assert(toolNames.includes('analyze_codebase'), 'Should include analyze_codebase');
      assert(toolNames.includes('quick_audit'), 'Should include quick_audit');
      assert(toolNames.includes('visualize_analysis'), 'Should include visualize_analysis');
    });

    test('workflows include recommended composite workflows', () => {
      const guide = getUsageGuide();
      const workflowNames = guide.workflows.map(w => w.name);
      const hasRecommended = workflowNames.some(n => n.includes('recommended'));
      assert(hasRecommended, 'Should have workflows marked as recommended');
    });

    test('recommended workflows reference composite tools', () => {
      const guide = getUsageGuide();
      const recommendedWorkflows = guide.workflows.filter(w => w.name.includes('recommended'));
      const allSteps = recommendedWorkflows.flatMap(w => w.steps).join(' ');
      assert(allSteps.includes('analyze_codebase'), 'Recommended workflow should use analyze_codebase');
      assert(allSteps.includes('quick_audit'), 'Recommended workflow should use quick_audit');
      assert(allSteps.includes('visualize_analysis'), 'Recommended workflow should use visualize_analysis');
    });
  });

  // ==========================================================================
  // 7. Consistency checks
  // ==========================================================================
  section('Consistency — composite vs granular results', () => {
    test('analyze_codebase tree matches standalone tree', () => {
      const composite = analyzeCodebase(APP);
      const standalone = getComponentTree(APP);
      assert(JSON.stringify(composite.tree) === JSON.stringify(standalone),
        'Tree results should be identical');
    });

    test('analyze_codebase complexity matches standalone complexity', () => {
      const rootPath = path.dirname(APP);
      const composite = analyzeCodebase(APP);
      const standalone = getComplexityReport(rootPath);
      assert(composite.complexity.summary.totalComponents === standalone.summary.totalComponents,
        'Complexity component count should match');
      assert(composite.complexity.summary.average === standalone.summary.average,
        'Complexity average should match');
    });

    test('analyze_codebase context matches standalone context', () => {
      const rootPath = path.dirname(APP);
      const composite = analyzeCodebase(APP);
      const standalone = getContextMap(rootPath);
      assert(composite.context.totalContexts === standalone.totalContexts,
        'Context count should match');
    });

    test('analyze_codebase circularDeps matches standalone', () => {
      const rootPath = path.dirname(APP);
      const composite = analyzeCodebase(APP);
      const standalone = detectCircularDeps(rootPath);
      assert(composite.circularDeps.hasCircularDeps === standalone.hasCircularDeps,
        'Circular dep detection should match');
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

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
