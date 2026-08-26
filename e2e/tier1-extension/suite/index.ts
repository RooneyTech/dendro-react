// e2e/tier1-extension/suite/index.ts
//
// Mocha runner for E2E extension tests.
// Writes results to E2E_RESULT_FILE if set (for parent process verification).

import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';
import { glob } from 'glob';

function writeResults(runner: Mocha.Runner, failedTests: Array<{ title: string; error: string }>) {
  const resultFile = process.env.E2E_RESULT_FILE;
  if (!resultFile) return;

  const result = {
    passed: runner.stats?.passes || 0,
    failed: runner.stats?.failures || 0,
    total: runner.stats?.tests || 0,
    failures: failedTests,
  };

  try {
    const dir = path.dirname(resultFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
    console.log('E2E results written to:', resultFile);
  } catch (err) {
    console.error('Failed to write result file:', err);
  }
}

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 60000
  });

  const testsRoot = path.resolve(__dirname);

  const testFiles = await glob('**/extension.e2e.js', {
    cwd: testsRoot,
    absolute: true
  });

  console.log('E2E test files found:', testFiles);

  testFiles.forEach(file => mocha.addFile(file));

  return new Promise<void>((resolve, reject) => {
    const failedTests: Array<{ title: string; error: string }> = [];

    const runner = mocha.run(failures => {
      writeResults(runner, failedTests);
      if (failures > 0) {
        reject(new Error(`${failures} E2E tests failed.`));
      } else {
        resolve();
      }
    });

    runner.on('fail', (test: Mocha.Test, err: Error) => {
      failedTests.push({
        title: test.fullTitle(),
        error: err.message || 'unknown error',
      });
    });
  });
}
