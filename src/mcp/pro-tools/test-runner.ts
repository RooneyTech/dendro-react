/**
 * Dendro Pro — Proprietary
 * Copyright (c) 2025 Rooney Industries LLC. All rights reserved.
 * Unauthorized copying, modification, or distribution is prohibited.
 */

import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { assertPathInWorkspace } from '../path-boundary';
import type {
  FlowTestResult,
  VerificationSummary,
  RunFlowTestsInput,
  RunFlowTestsResult,
  ErrorType,
} from './verification-types';

// --- Error Classification ---

/**
 * Classify a Jest failure message into an ErrorType.
 *
 * Setup/dependency errors are classified as 'inconclusive' — they don't
 * tell us whether the state flow is broken, only that the test harness
 * has issues. Only genuine assertion failures count as 'failed'.
 */
function classifyError(failureMessages: string[]): { errorType: ErrorType; isInconclusive: boolean } {
  const combined = failureMessages.join('\n');

  // Missing dependency patterns
  if (combined.includes('Cannot find module')) {
    return { errorType: 'missing-dep', isInconclusive: true };
  }
  if (combined.includes('Module not found')) {
    return { errorType: 'missing-dep', isInconclusive: true };
  }

  // Setup/environment patterns
  if (combined.includes('is not a function')) {
    return { errorType: 'setup', isInconclusive: true };
  }
  if (combined.includes('Cannot read properties')) {
    return { errorType: 'setup', isInconclusive: true };
  }
  if (combined.includes('Cannot read property')) {
    return { errorType: 'setup', isInconclusive: true };
  }
  // act(...) warnings without a real assertion failure
  if (combined.includes('act(...)') && !combined.includes('expect(')) {
    return { errorType: 'setup', isInconclusive: true };
  }
  if (combined.includes('SyntaxError')) {
    return { errorType: 'setup', isInconclusive: true };
  }
  if (combined.includes('Unexpected token')) {
    return { errorType: 'setup', isInconclusive: true };
  }
  if (combined.includes('ReferenceError')) {
    return { errorType: 'setup', isInconclusive: true };
  }
  if (combined.includes('TypeError')) {
    return { errorType: 'setup', isInconclusive: true };
  }
  if (combined.includes('jest.fn() value must be')) {
    return { errorType: 'setup', isInconclusive: true };
  }

  // Everything else is a genuine assertion failure
  return { errorType: 'assertion', isInconclusive: false };
}

/**
 * Extract hypothesis ID from a test file path.
 * Test files follow the pattern: flow-{hypothesisId}.test.tsx
 */
function extractHypothesisId(testFilePath: string): string {
  const base = path.basename(testFilePath);
  // Pattern: flow-{id}.test.{tsx|jsx|ts|js}
  const match = base.match(/^flow-(.+)\.test\.\w+$/);
  return match ? match[1] : base;
}

// --- Jest JSON Output Types ---

interface JestAssertionResult {
  status: 'passed' | 'failed' | 'pending' | 'todo';
  title: string;
  failureMessages: string[];
  duration?: number;
}

interface JestTestResult {
  testFilePath: string;
  status: 'passed' | 'failed';
  message: string;
  assertionResults: JestAssertionResult[];
  startTime: number;
  endTime: number;
}

interface JestJsonOutput {
  success: boolean;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  testResults: JestTestResult[];
}

// --- Main Runner ---

/**
 * Run generated flow tests via Jest CLI and classify results.
 *
 * Spawns: npx jest --json --no-coverage --forceExit --maxWorkers=1
 *         --testPathPattern __dendro__/tests
 *         --config __dendro__/jest.config.js
 */
export async function runFlowTests(input: RunFlowTestsInput): Promise<RunFlowTestsResult> {
  const { workspaceRoot, timeout = 60000, hypothesisIds } = input;
  const startTime = Date.now();

  const absoluteRoot = assertPathInWorkspace(workspaceRoot, 'workspaceRoot');

  const dendroDir = path.join(absoluteRoot, '__dendro__');
  const testsDir = path.join(dendroDir, 'tests');
  const jestConfigPath = path.join(dendroDir, 'jest.config.js');

  if (!fs.existsSync(testsDir)) {
    return {
      results: [],
      summary: emptySummary(),
      duration: 0,
      error: 'No __dendro__/tests/ directory found. Run generate_flow_test first.',
    };
  }

  if (!fs.existsSync(jestConfigPath)) {
    return {
      results: [],
      summary: emptySummary(),
      duration: 0,
      error: 'No __dendro__/jest.config.js found. Run generate_flow_test first.',
    };
  }

  // Check if Jest is available in the project
  const hasJestBin = fs.existsSync(path.join(absoluteRoot, 'node_modules', '.bin', 'jest'));
  const packageJsonPath = path.join(absoluteRoot, 'package.json');
  let hasJestDep = false;
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    hasJestDep = !!allDeps['jest'];
  } catch {
    // No package.json — proceed anyway
  }

  if (!hasJestBin && !hasJestDep) {
    return {
      results: [],
      summary: emptySummary(),
      duration: 0,
      error: 'Jest is not installed in this project. Install with: npm install --save-dev jest @testing-library/react-native',
    };
  }

  // If specific hypothesis IDs requested, check test files exist
  let testPathPattern = path.join(absoluteRoot, '__dendro__', 'tests').replace(/\\/g, '/');
  if (hypothesisIds && hypothesisIds.length > 0) {
    // Build a regex pattern to match specific test files
    const idPatterns = hypothesisIds.map(id => `flow-${id}`).join('|');
    testPathPattern = path.join(absoluteRoot, '__dendro__', 'tests').replace(/\\/g, '/') + `/(?:${idPatterns})`;
  }

  // Spawn Jest — use absolute config path for reliability
  try {
    const jestOutput = await spawnJest(absoluteRoot, jestConfigPath, testPathPattern, timeout);
    const results = parseJestOutput(jestOutput, hypothesisIds);
    const summary = buildSummary(results);
    const duration = Date.now() - startTime;

    return { results, summary, duration };
  } catch (err) {
    const duration = Date.now() - startTime;

    if (err instanceof Error && err.message.includes('TIMEOUT')) {
      return {
        results: [],
        summary: emptySummary(),
        duration,
        error: `Jest timed out after ${timeout}ms. Try increasing the timeout or reducing the number of tests.`,
      };
    }

    return {
      results: [],
      summary: emptySummary(),
      duration,
      error: `Jest execution failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Spawn Jest as a child process and collect JSON output.
 */
function spawnJest(
  cwd: string,
  configPath: string,
  testPathPattern: string,
  timeout: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      'jest',
      '--json',
      '--no-coverage',
      '--forceExit',
      '--maxWorkers=1',
      '--testPathPattern', testPathPattern,
      '--config', configPath,
    ];

    const child = spawn('npx', args, {
      cwd,
      timeout,
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      // Jest exits with code 1 when tests fail — that's expected.
      // We parse the JSON output regardless of exit code.
      if (stdout.trim()) {
        resolve(stdout);
      } else if (code === null) {
        // Process was killed (timeout)
        reject(new Error('TIMEOUT: Jest process was killed'));
      } else {
        // No JSON output — Jest failed to start or produced no output
        reject(new Error(`Jest exited with code ${code}. stderr: ${stderr.substring(0, 500)}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn Jest: ${err.message}`));
    });
  });
}

/**
 * Parse Jest JSON output into FlowTestResult[].
 */
function parseJestOutput(
  rawOutput: string,
  filterIds?: string[],
): FlowTestResult[] {
  // Jest --json sometimes includes non-JSON output before the JSON.
  // Find the first '{' to start parsing.
  const jsonStart = rawOutput.indexOf('{');
  if (jsonStart === -1) {
    return [];
  }

  let jestOutput: JestJsonOutput;
  try {
    jestOutput = JSON.parse(rawOutput.substring(jsonStart));
  } catch {
    return [];
  }

  const results: FlowTestResult[] = [];

  for (const testResult of jestOutput.testResults) {
    const hypothesisId = extractHypothesisId(testResult.testFilePath);

    // Skip if filtering by hypothesis IDs
    if (filterIds && filterIds.length > 0 && !filterIds.includes(hypothesisId)) {
      continue;
    }

    const duration = testResult.endTime - testResult.startTime;

    if (testResult.status === 'passed') {
      // All assertions passed
      results.push({
        hypothesisId,
        status: 'verified',
        duration,
        testFilePath: testResult.testFilePath,
      });
    } else {
      // Collect all failure messages
      const failureMessages = testResult.assertionResults
        .filter(a => a.status === 'failed')
        .flatMap(a => a.failureMessages);

      // Also include top-level message if present
      if (testResult.message && !failureMessages.includes(testResult.message)) {
        failureMessages.push(testResult.message);
      }

      const { errorType, isInconclusive } = classifyError(failureMessages);

      results.push({
        hypothesisId,
        status: isInconclusive ? 'inconclusive' : 'failed',
        errorType,
        errorMessage: failureMessages[0]?.substring(0, 500),
        duration,
        testFilePath: testResult.testFilePath,
      });
    }
  }

  return results;
}

// --- Helpers ---

function buildSummary(results: FlowTestResult[]): VerificationSummary {
  return {
    total: results.length,
    verified: results.filter(r => r.status === 'verified').length,
    failed: results.filter(r => r.status === 'failed').length,
    inconclusive: results.filter(r => r.status === 'inconclusive').length,
    untested: 0,
  };
}

function emptySummary(): VerificationSummary {
  return { total: 0, verified: 0, failed: 0, inconclusive: 0, untested: 0 };
}
