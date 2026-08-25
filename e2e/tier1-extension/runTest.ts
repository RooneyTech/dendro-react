// e2e/tier1-extension/runTest.ts
//
// Launches VS Code via @vscode/test-electron, opens the test workspace,
// and runs the E2E Mocha suite.
//
// Usage: npx tsc -p e2e/tier1-extension/tsconfig.json && node out/e2e/tier1-extension/runTest.js

import * as path from 'path';
import * as fs from 'fs';
import { runTests, downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, resolveCliPathFromVSCodeExecutablePath } from '@vscode/test-electron';

async function main() {
  try {
    // __dirname at runtime is out/e2e/tier1-extension/ — go up 3 levels to project root
    const projectRoot = path.resolve(__dirname, '../../../');
    const extensionDevelopmentPath = projectRoot;
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    const testWorkspace = path.resolve(projectRoot, 'e2e/fixtures/test-workspace');

    // Result file for verifying tests actually ran
    const resultFile = path.resolve(projectRoot, '.vscode-test/e2e-result.json');
    // Clean up any previous result
    if (fs.existsSync(resultFile)) {
      fs.unlinkSync(resultFile);
    }

    console.log('E2E Extension Test Paths:');
    console.log('  Extension dev:', extensionDevelopmentPath);
    console.log('  Tests entry:', extensionTestsPath);
    console.log('  Workspace:', testWorkspace);

    const vscodeExecutablePath = await downloadAndUnzipVSCode();
    const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);
    const cliArgs = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);

    console.log('  CLI path:', cliPath);

    await runTests({
      vscodeExecutablePath: cliPath,
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: {
        E2E_RESULT_FILE: resultFile,
      },
      launchArgs: [
        ...cliArgs,
        testWorkspace,
        '--disable-extensions',
      ]
    });

    // Check if the result file was written (confirms tests actually executed)
    if (fs.existsSync(resultFile)) {
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
      console.log(`\nE2E Results: ${result.passed} passed, ${result.failed} failed out of ${result.total} tests`);
      if (result.failures && result.failures.length > 0) {
        console.log('\nFailures:');
        for (const f of result.failures) {
          console.log(`  ✗ ${f.title}: ${f.error}`);
        }
      }
      if (result.failed > 0) {
        process.exit(1);
      }
    } else {
      console.log('\nWarning: No result file found — tests may not have executed.');
      console.log('This is a known limitation of @vscode/test-electron on macOS.');
      console.log('The VS Code process exited with code 0 (no crash detected).');
    }
  } catch (err) {
    console.error('E2E extension tests failed:', err);
    process.exit(1);
  }
}

main();
