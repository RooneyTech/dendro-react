// src/test/runTest.ts
import * as path from 'path';
import {
    runTests,
    downloadAndUnzipVSCode,
    resolveCliArgsFromVSCodeExecutablePath,
    resolveCliPathFromVSCodeExecutablePath
} from '@vscode/test-electron';

async function main() {
    try {
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        const extensionTestsPath = path.resolve(__dirname, './suite/index');

        console.log('Test paths:');
        console.log('Development path:', extensionDevelopmentPath);
        console.log('Tests path:', extensionTestsPath);

        // Download VS Code and resolve the CLI path
        // (macOS now packages Electron differently — MacOS/Electron is Node.js,
        //  not the VS Code binary. We need the CLI wrapper instead.)
        const vscodeExecutablePath = await downloadAndUnzipVSCode();
        const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);
        const cliArgs = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);

        console.log('CLI path:', cliPath);

        await runTests({
            vscodeExecutablePath: cliPath,
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: cliArgs
        });
    } catch (err) {
        console.error('Failed to run tests:', err);
        process.exit(1);
    }
}

main();
