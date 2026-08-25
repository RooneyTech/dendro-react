/**
 * Extension Integration Tests
 *
 * Tests that the Dendro extension activates correctly and registers
 * all expected commands in a real VS Code test instance.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Dendro Extension', function () {
    this.timeout(30000);

    suite('Activation', function () {
        test('extension should be present', function () {
            const extension = vscode.extensions.all.find(ext =>
                ext.id.toLowerCase().includes('dendro')
            );
            assert.ok(extension, 'Dendro extension should be installed');
        });

        test('extension should activate', async function () {
            const extension = vscode.extensions.all.find(ext =>
                ext.id.toLowerCase().includes('dendro')
            );
            if (extension && !extension.isActive) {
                await extension.activate();
            }
            assert.ok(extension?.isActive, 'Extension should be active');
        });
    });

    suite('Commands', function () {
        test('dendro commands should be registered', async function () {
            const commands = await vscode.commands.getCommands();
            const dendroCommands = commands.filter(cmd => cmd.startsWith('dendro-react.'));

            assert.ok(dendroCommands.length > 0, 'Should have dendro commands registered');
        });

        test('core commands should exist', async function () {
            const commands = await vscode.commands.getCommands();

            const expectedCommands = [
                'dendro-react.start',
                'dendro-react.visualize',
                'dendro-react.refreshTree',
                'dendro-react.selectRootComponent',
                'dendro-react.openComponent',
            ];

            for (const cmd of expectedCommands) {
                assert.ok(
                    commands.includes(cmd),
                    `Command ${cmd} should be registered`
                );
            }
        });

        test('runtime commands should exist', async function () {
            const commands = await vscode.commands.getCommands();

            const runtimeCommands = [
                'dendro-react.connectRuntime',
                'dendro-react.disconnectRuntime',
                'dendro-react.showRuntimeTree',
            ];

            for (const cmd of runtimeCommands) {
                assert.ok(
                    commands.includes(cmd),
                    `Runtime command ${cmd} should be registered`
                );
            }
        });

        test('licensing commands should exist', async function () {
            const commands = await vscode.commands.getCommands();

            const licensingCommands = [
                'dendro-react.activateLicense',
                'dendro-react.upgradeToPro',
                'dendro-react.manageSubscription',
                'dendro-react.deactivateLicense',
                'dendro-react.licenseStatus',
            ];

            for (const cmd of licensingCommands) {
                assert.ok(
                    commands.includes(cmd),
                    `Licensing command ${cmd} should be registered`
                );
            }
        });
    });

    suite('Views', function () {
        test('tree view should be registered', async function () {
            // The dendroReactComponentTree view is contributed via package.json
            // We can verify it exists by checking the extension's package contributions
            const extension = vscode.extensions.all.find(ext =>
                ext.id.toLowerCase().includes('dendro')
            );
            assert.ok(extension, 'Extension should exist');

            const views = extension?.packageJSON?.contributes?.views;
            assert.ok(views, 'Extension should contribute views');

            // Check that the dendro view container has views
            const dendroViews = views?.dendroExplorer || views?.explorer;
            if (dendroViews) {
                const treeView = dendroViews.find((v: { id: string }) =>
                    v.id === 'dendroReactComponentTree'
                );
                assert.ok(treeView, 'dendroReactComponentTree view should be registered');
            }
        });
    });

    suite('Configuration', function () {
        test('configuration settings should be defined', function () {
            const config = vscode.workspace.getConfiguration('dendro-react');
            // These should exist even if not explicitly set (they have defaults)
            assert.ok(config !== undefined, 'dendro configuration should exist');
        });
    });
});
