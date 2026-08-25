#!/usr/bin/env node
/**
 * Unified test runner — runs all 20 custom harness test suites sequentially
 * and reports a combined summary. Continues past failures so every suite runs.
 */

const { execSync } = require('child_process');
const path = require('path');

const SCRIPTS_DIR = path.join(__dirname);

const suites = [
  'test-pro-features.js',
  'test-runtime-features.js',
  'test-phase1e-webview-runtime.js',
  'test-pro-tools.js',
  'test-verification.js',
  'test-triggered-projection.js',
  'test-live-introspection.js',
  'test-phase3-resilience.js',
  'test-phase4-advanced.js',
  'test-phase4b-tracing.js',
  'test-e2e-simulation.js',
  'test-p0-theme-audit.js',
  'test-open-visualizer.js',
  'test-visualizer-bridge.js',
  'test-composite-tools.js',
  'test-viz-reliability.js',
  'test-tour-mode.js',
  'test-rerender-risks.js',
  'test-web-routing.js',
  'test-modification-tracker.js',
];

const results = [];
let totalPassed = 0;
let totalFailed = 0;

/**
 * Extract the LAST pass/fail counts from test output.
 * Test scripts print intermediate section counts then a final summary.
 * We want the final summary line.
 */
function extractCounts(output) {
  // Find all lines with "N passed" — take the last one
  const passMatches = [...output.matchAll(/(\d+)\s+passed/g)];
  const failMatches = [...output.matchAll(/(\d+)\s+failed/g)];

  const passed = passMatches.length > 0
    ? parseInt(passMatches[passMatches.length - 1][1], 10)
    : 0;
  const failed = failMatches.length > 0
    ? parseInt(failMatches[failMatches.length - 1][1], 10)
    : 0;

  return { passed, failed };
}

console.log('='.repeat(60));
console.log('  Dendro — Running all test suites');
console.log('='.repeat(60));
console.log();

for (const suite of suites) {
  const scriptPath = path.join(SCRIPTS_DIR, suite);
  const label = suite.replace('test-', '').replace('.js', '');
  process.stdout.write(`  ${label} ... `);

  try {
    const output = execSync(`node "${scriptPath}"`, {
      encoding: 'utf-8',
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const { passed, failed } = extractCounts(output);
    totalPassed += passed;
    totalFailed += failed;

    if (failed > 0) {
      console.log(`${passed} passed, ${failed} FAILED`);
      results.push({ suite: label, passed, failed, error: false });
    } else {
      console.log(`${passed} passed`);
      results.push({ suite: label, passed, failed: 0, error: false });
    }
  } catch (err) {
    // Process exited non-zero — extract counts from whatever output we got
    const output = (err.stdout || '') + (err.stderr || '');
    const { passed, failed } = extractCounts(output);

    totalPassed += passed;
    totalFailed += failed;

    if (passed > 0 || failed > 0) {
      console.log(`${passed} passed, ${failed} FAILED (exit code ${err.status})`);
    } else {
      console.log(`CRASHED (exit code ${err.status})`);
      totalFailed += 1;
    }
    results.push({ suite: label, passed, failed: failed || 1, error: true });
  }
}

console.log();
console.log('='.repeat(60));
console.log(`  TOTAL: ${totalPassed + totalFailed} tests | ${totalPassed} passed | ${totalFailed} failed`);
console.log('='.repeat(60));

if (totalFailed > 0) {
  console.log();
  console.log('  Failed suites:');
  for (const r of results) {
    if (r.failed > 0) {
      console.log(`    - ${r.suite} (${r.failed} failed)`);
    }
  }
}

console.log();
process.exit(totalFailed > 0 ? 1 : 0);
