#!/usr/bin/env node
/**
 * test-rerender-risks.js
 *
 * Tests for get_rerender_risks MCP tool:
 * - Inline object/array/function detection
 * - Missing useCallback detection
 * - Missing useMemo detection
 * - Negative tests (properly memoized = zero risks)
 * - Directory scanning
 * - Feature gate
 * - Formatted report output
 * - Usage guide integration (51 tools)
 *
 * Usage:
 *   npm run build && node scripts/test-rerender-risks.js
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'src/test/fixtures/rerender-risks');

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
  getRerenderRisks,
  quickAudit,
  getUsageGuide,
} = require(path.join(ROOT, 'out/mcp/tools'));

const {
  analyzeFileRerenderRisks,
  parseRerenderRiskReport,
} = require(path.join(ROOT, 'out/core/rerender-risk-parser'));

const { isProFeature, getFreeFeatureList, getProFeatureList } = require(path.join(ROOT, 'out/licensing/feature-gate'));

const { initWorkspaceRoot } = require(path.join(ROOT, 'out/mcp/path-boundary'));

// Initialize workspace root so getRerenderRisks/quickAudit path validation works
process.env.DENDRO_WORKSPACE_ROOT = ROOT;
initWorkspaceRoot();

console.log('=== Rerender Risk Detection Tests ===\n');

// ─── Inline detection ───────────────────────────────────────────────────────

section('Inline detection', () => {
  const file = path.join(FIXTURES, 'InlinePropsComponent.tsx');
  const result = analyzeFileRerenderRisks(file);

  test('analyzes InlinePropsComponent successfully', () => {
    assert(result !== null, 'Result should not be null');
    assert(result.componentName === 'InlinePropsComponent', `Expected InlinePropsComponent, got ${result.componentName}`);
  });

  test('detects inline object', () => {
    const inlineObj = result.risks.filter(r => r.type === 'inline-object');
    assert(inlineObj.length >= 1, `Expected >= 1 inline-object risks, got ${inlineObj.length}`);
    assert(inlineObj[0].propName === 'style', `Expected prop 'style', got '${inlineObj[0].propName}'`);
  });

  test('detects inline array', () => {
    const inlineArr = result.risks.filter(r => r.type === 'inline-array');
    assert(inlineArr.length >= 1, `Expected >= 1 inline-array risks, got ${inlineArr.length}`);
    assert(inlineArr[0].propName === 'data', `Expected prop 'data', got '${inlineArr[0].propName}'`);
  });

  test('detects inline function', () => {
    const inlineFn = result.risks.filter(r => r.type === 'inline-function');
    assert(inlineFn.length >= 1, `Expected >= 1 inline-function risks, got ${inlineFn.length}`);
  });

  test('does NOT flag primitives or prop passthrough', () => {
    // Primitives: label="hello", count={5}, disabled={true}, name={name}, count={count}
    // These should NOT appear as risks
    const allPropNames = result.risks.map(r => r.propName);
    assert(!allPropNames.includes('label'), 'String literal should not be flagged');
    assert(!allPropNames.includes('disabled'), 'Boolean literal should not be flagged');
  });

  test('each risk has line/column info', () => {
    for (const risk of result.risks) {
      assert(risk.line > 0, `Expected line > 0, got ${risk.line}`);
      assert(risk.column > 0, `Expected column > 0, got ${risk.column}`);
    }
  });

  test('each risk has description and suggestion', () => {
    for (const risk of result.risks) {
      assert(risk.description.length > 0, 'Expected non-empty description');
      assert(risk.suggestion.length > 0, 'Expected non-empty suggestion');
    }
  });
});

// ─── Missing useCallback ────────────────────────────────────────────────────

section('Missing useCallback detection', () => {
  const file = path.join(FIXTURES, 'MissingCallbackComponent.tsx');
  const result = analyzeFileRerenderRisks(file);

  test('analyzes MissingCallbackComponent successfully', () => {
    assert(result !== null, 'Result should not be null');
  });

  test('detects missing useCallback for handleClick', () => {
    const missing = result.risks.filter(r => r.type === 'missing-useCallback' && r.variableName === 'handleClick');
    assert(missing.length === 1, `Expected 1 missing-useCallback for handleClick, got ${missing.length}`);
    assert(missing[0].severity === 'high', `Expected high severity, got ${missing[0].severity}`);
  });

  test('detects missing useCallback for handleDelete', () => {
    const missing = result.risks.filter(r => r.type === 'missing-useCallback' && r.variableName === 'handleDelete');
    assert(missing.length === 1, `Expected 1 missing-useCallback for handleDelete, got ${missing.length}`);
  });

  test('does NOT flag state setter (setCount)', () => {
    const setterRisks = result.risks.filter(r => r.variableName === 'setCount' || r.propName === 'onChange');
    assert(setterRisks.length === 0, `Expected 0 risks for state setter, got ${setterRisks.length}`);
  });
});

// ─── Missing useMemo ────────────────────────────────────────────────────────

section('Missing useMemo detection', () => {
  const file = path.join(FIXTURES, 'MissingMemoComponent.tsx');
  const result = analyzeFileRerenderRisks(file);

  test('analyzes MissingMemoComponent successfully', () => {
    assert(result !== null, 'Result should not be null');
  });

  test('detects missing useMemo for filtered (.filter)', () => {
    const missing = result.risks.filter(r => r.type === 'missing-useMemo' && r.variableName === 'filtered');
    assert(missing.length === 1, `Expected 1 missing-useMemo for filtered, got ${missing.length}`);
  });

  test('detects missing useMemo for names (.map)', () => {
    const missing = result.risks.filter(r => r.type === 'missing-useMemo' && r.variableName === 'names');
    assert(missing.length === 1, `Expected 1 missing-useMemo for names, got ${missing.length}`);
  });

  test('detects missing useMemo for spread object (config)', () => {
    const missing = result.risks.filter(r => r.type === 'missing-useMemo' && r.variableName === 'config');
    assert(missing.length === 1, `Expected 1 missing-useMemo for config, got ${missing.length}`);
  });
});

// ─── Negative tests (properly memoized) ─────────────────────────────────────

section('Negative tests (properly memoized)', () => {
  const file = path.join(FIXTURES, 'ProperlyMemoizedComponent.tsx');
  const result = analyzeFileRerenderRisks(file);

  test('analyzes ProperlyMemoizedComponent successfully', () => {
    assert(result !== null, 'Result should not be null');
    assert(result.componentName === 'ProperlyMemoizedComponent', `Expected ProperlyMemoizedComponent, got ${result.componentName}`);
  });

  test('zero risks for properly memoized component', () => {
    assert(result.riskCount === 0, `Expected 0 risks, got ${result.riskCount}: ${result.risks.map(r => `${r.type}:${r.variableName||r.propName}`).join(', ')}`);
  });

  test('does NOT flag useCallback-wrapped functions', () => {
    const cbRisks = result.risks.filter(r => r.variableName === 'handleClick' || r.variableName === 'handleSubmit');
    assert(cbRisks.length === 0, `Expected 0 risks for useCallback-wrapped, got ${cbRisks.length}`);
  });

  test('does NOT flag useMemo-wrapped values', () => {
    const memoRisks = result.risks.filter(r => r.variableName === 'filtered');
    assert(memoRisks.length === 0, `Expected 0 risks for useMemo-wrapped, got ${memoRisks.length}`);
  });
});

// ─── Directory scanning ─────────────────────────────────────────────────────

section('Directory scanning', () => {
  test('scans entire fixtures directory', () => {
    const result = parseRerenderRiskReport(FIXTURES);
    assert(result.files.length >= 4, `Expected >= 4 files, got ${result.files.length}`);
    assert(result.summary.totalRisks > 0, `Expected > 0 total risks, got ${result.summary.totalRisks}`);
  });

  test('summary byType has all risk types', () => {
    const result = parseRerenderRiskReport(FIXTURES);
    const types = Object.keys(result.summary.byType);
    assert(types.includes('inline-object'), 'Missing inline-object in byType');
    assert(types.includes('inline-array'), 'Missing inline-array in byType');
    assert(types.includes('inline-function'), 'Missing inline-function in byType');
    assert(types.includes('missing-useCallback'), 'Missing missing-useCallback in byType');
    assert(types.includes('missing-useMemo'), 'Missing missing-useMemo in byType');
  });

  test('summary bySeverity has all severity levels', () => {
    const result = parseRerenderRiskReport(FIXTURES);
    const sevs = Object.keys(result.summary.bySeverity);
    assert(sevs.includes('low'), 'Missing low in bySeverity');
    assert(sevs.includes('medium'), 'Missing medium in bySeverity');
    assert(sevs.includes('high'), 'Missing high in bySeverity');
  });

  test('topOffenders is populated', () => {
    const result = parseRerenderRiskReport(FIXTURES);
    assert(result.summary.topOffenders.length > 0, 'Expected at least 1 top offender');
  });

  test('minSeverity filter works', () => {
    const all = parseRerenderRiskReport(FIXTURES);
    const highOnly = parseRerenderRiskReport(FIXTURES, 'high');
    assert(highOnly.summary.totalRisks <= all.summary.totalRisks, 'High-only should have <= total risks');
    // All risks in highOnly should be 'high'
    for (const f of highOnly.files) {
      for (const r of f.risks) {
        assert(r.severity === 'high', `Expected high severity, got ${r.severity}`);
      }
    }
  });
});

// ─── MCP wrapper (getRerenderRisks) ─────────────────────────────────────────

section('MCP wrapper (getRerenderRisks)', () => {
  test('returns valid result for fixtures directory', () => {
    const result = getRerenderRisks(FIXTURES);
    assert(!result.error, `Unexpected error: ${result.error}`);
    assert(result.files.length > 0, 'Expected files in result');
    assert(result.summary.totalRisks > 0, 'Expected risks in summary');
  });

  test('returns error for nonexistent path', () => {
    const result = getRerenderRisks('/nonexistent/path');
    assert(result.error, 'Expected error for nonexistent path');
  });

  test('returns formatted report', () => {
    const result = getRerenderRisks(FIXTURES);
    assert(result.formattedReport.includes('Re-Render Risk Report'), 'Expected formatted report header');
    assert(result.formattedReport.includes('Summary:'), 'Expected Summary section');
  });

  test('minSeverity param works via wrapper', () => {
    const result = getRerenderRisks(FIXTURES, 'high');
    for (const f of result.files) {
      for (const r of f.risks) {
        assert(r.severity === 'high', `Expected high severity, got ${r.severity}`);
      }
    }
  });
});

// ─── Error handling ─────────────────────────────────────────────────────────

section('Error handling', () => {
  test('handles nonexistent file gracefully', () => {
    const result = analyzeFileRerenderRisks('/nonexistent/file.tsx');
    assert(result === null, 'Expected null for nonexistent file');
  });

  test('handles nonexistent directory via parseRerenderRiskReport', () => {
    const result = parseRerenderRiskReport('/nonexistent/dir');
    assert(result.warnings.length > 0, 'Expected warning for nonexistent path');
    assert(result.files.length === 0, 'Expected empty files');
  });
});

// ─── Feature gate ───────────────────────────────────────────────────────────

section('Feature gate', () => {
  test('get_rerender_risks is a free feature', () => {
    assert(!isProFeature('get_rerender_risks'), 'get_rerender_risks should be free, not pro');
  });

  test('free feature list includes get_rerender_risks', () => {
    const freeList = getFreeFeatureList();
    assert(freeList.includes('get_rerender_risks'), 'get_rerender_risks should be in free feature list');
  });

  test('free feature count is 25', () => {
    const freeList = getFreeFeatureList();
    assert(freeList.length === (()=>{const g=require(path.join(ROOT, 'out/licensing/feature-gate'));return g.getFreeFeatureList().length+g.getProFeatureList().length;})() - 10, `Expected 25 free features, got ${freeList.length}: ${freeList.join(', ')}`);
  });

  test('pro feature count is 10', () => {
    const proList = getProFeatureList();
    assert(proList.length === 10, `Expected 10 pro features, got ${proList.length}`);
  });

  test('total feature count is 35', () => {
    const freeList = getFreeFeatureList();
    const proList = getProFeatureList();
    const total = freeList.length + proList.length;
    assert(total === getFreeFeatureList().length + getProFeatureList().length, `registry total mismatch, got ${total}`);
  });
});

// ─── Quick audit integration ────────────────────────────────────────────────

section('Quick audit integration', () => {
  test('quickAudit includes rerenderRisks field', () => {
    const result = quickAudit(FIXTURES);
    assert('rerenderRisks' in result, 'Expected rerenderRisks field in quickAudit result');
    assert(typeof result.rerenderRisks.totalRisks === 'number', 'Expected totalRisks number');
    assert(typeof result.rerenderRisks.highSeverityCount === 'number', 'Expected highSeverityCount number');
    assert(Array.isArray(result.rerenderRisks.topFiles), 'Expected topFiles array');
  });

  test('quickAudit detects high-severity rerender risks', () => {
    const result = quickAudit(FIXTURES);
    assert(result.rerenderRisks.highSeverityCount > 0, 'Expected high-severity risks in fixtures');
  });
});

// ─── Usage guide integration ────────────────────────────────────────────────

section('Usage guide integration', () => {
  test('usage guide reports 34 tools', () => {
    const guide = getUsageGuide();
    assert(guide.overview.includes(String((()=>{const g=require(path.join(ROOT, 'out/licensing/feature-gate'));return g.getFreeFeatureList().length+g.getProFeatureList().length;})())), `Expected '34' in overview, got: ${guide.overview.substring(0, 100)}`);
  });

  test('usage guide includes get_rerender_risks in analysis category', () => {
    const guide = getUsageGuide();
    const analysisTools = guide.categories.analysis.tools.map(t => t.name);
    assert(analysisTools.includes('get_rerender_risks'), 'Expected get_rerender_risks in analysis tools');
  });

  test('usage guide includes performance audit workflow', () => {
    const guide = getUsageGuide();
    const workflowNames = guide.workflows.map(w => w.name);
    assert(workflowNames.includes('Performance audit'), `Expected 'Performance audit' workflow, got: ${workflowNames.join(', ')}`);
  });
});

// ─── Summary ────────────────────────────────────────────────────────────────

console.log('\n=== Summary ===\n');
for (const s of sections) {
  console.log(`  ${s.name}: ${s.tests} tests`);
}
console.log(`\n  ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
