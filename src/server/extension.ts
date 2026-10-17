import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { buildComponentTree, setCache } from './parser-oxc';
import { createExtensionCache } from '../core/cache';
import { createFileWatcher } from '../core/file-watcher';
import { ComponentUsageCodeLensProvider } from './codelens-provider';
import { ComponentTreeProvider, ComponentTreeItem } from './tree-view-provider';
import { DisposableOptions } from '../types';
import { webviewRegistry } from './webview-bridge';
import { recordWebviewError } from '../mcp/telemetry';
import { getDevToolsConnector, type ConnectionStatus, type RuntimeTree, type InspectedElement } from '../runtime';
import { SourceMapper } from '../runtime/source-mapper';
import { writeRuntimeState, clearRuntimeState } from '../runtime/runtime-state-file';
import {
  readInspectRequest,
  writeInspectResult,
  clearInspectRequest,
  readOverrideRequest,
  writeOverrideResult,
  clearOverrideRequest,
  getInspectPaths,
} from '../runtime/inspect-bridge';
import type { InspectResult, OverrideResult } from '../runtime/inspect-bridge';
import { writeVisualizerReady, clearVisualizerStatus } from '../runtime/visualizer-bridge';
import { computeWorkspaceHash, getWorkspaceIpcDir, ensureDir } from '../runtime/ipc-paths';
import { LicenseManager } from '../licensing/license-manager';

let licenseManagerInstance: LicenseManager | undefined;

/**
 * Convert flat RuntimeTree to hierarchical structure for D3 visualization.
 * Produces a shape compatible with the static ComponentNode format so the
 * existing Dendrogram component can render it with minimal changes.
 */
function buildRuntimeHierarchy(
  tree: RuntimeTree,
  sourceMap: Map<string, string>
): Record<string, unknown> {
  function mapType(runtimeType: string): string | null {
    if (runtimeType === 'function') return 'functional';
    if (runtimeType === 'class') return 'class';
    return null; // host, other
  }

  function buildNode(id: number): Record<string, unknown> | null {
    const component = tree.elements.get(id);
    if (!component) return null;

    const children = component.children
      .map(childId => buildNode(childId))
      .filter((c): c is Record<string, unknown> => c !== null);

    return {
      file: component.displayName || '(anonymous)',
      type: mapType(component.type),
      state: [],
      children,
      _runtime: true,
      _runtimeId: component.id,
      _displayName: component.displayName,
      _sourceFile: sourceMap.get(component.displayName) || null,
      _runtimeType: component.type,
    };
  }

  // Build trees for each root (roots are synthetic DevTools containers — use their children)
  const rootNodes: Record<string, unknown>[] = [];
  for (const rootId of tree.roots) {
    const root = tree.elements.get(rootId);
    if (!root) continue;
    for (const childId of root.children) {
      const node = buildNode(childId);
      if (node) rootNodes.push(node);
    }
  }

  if (rootNodes.length === 0) {
    return { file: 'Empty Tree', type: null, state: [], children: [], _runtime: true };
  } else if (rootNodes.length === 1) {
    return rootNodes[0];
  } else {
    return {
      file: 'App',
      type: 'functional',
      state: [],
      children: rootNodes,
      _runtime: true,
      _runtimeId: -1,
      _displayName: 'App',
      _runtimeType: 'other',
    };
  }
}

function activate(context: vscode.ExtensionContext) {
  console.log('Dendro extension activated');
  console.log('Dendro extension ID:', context.extension.id);
  console.log('Dendro URI scheme:', vscode.env.uriScheme);
  console.log(`Dendro URI handler listening on: ${vscode.env.uriScheme}://${context.extension.id}`);

  // Workspace Trust: defer full activation until workspace is trusted.
  // In untrusted workspaces, Dendro could scan arbitrary files, start a WebSocket
  // server, and write to ~/.dendro/ IPC bridges — all undesirable for untrusted code.
  if (!vscode.workspace.isTrusted) {
    console.log('Dendro: Workspace not trusted — running in restricted mode');

    const restrictedStatusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right, 100
    );
    restrictedStatusBar.text = '$(lock) Dendro: Restricted';
    restrictedStatusBar.tooltip = 'Trust this workspace to enable Dendro features';
    restrictedStatusBar.show();
    context.subscriptions.push(restrictedStatusBar);

    context.subscriptions.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        console.log('Dendro: Workspace trust granted — activating full features');
        restrictedStatusBar.dispose();
        activateTrustedFeatures(context);
      })
    );
    return;
  }

  activateTrustedFeatures(context);
}

function activateTrustedFeatures(context: vscode.ExtensionContext) {
  // Output Channel for tester-visible logging
  const outputChannel = vscode.window.createOutputChannel('Dendro React');
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine(`Dendro React activated (v${context.extension.packageJSON.version})`);

  // Set workspace hash for IPC namespace isolation (TICKET-056)
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspacePath) {
    const hash = computeWorkspaceHash(workspacePath);
    process.env.DENDRO_WORKSPACE_HASH = hash;
    outputChannel.appendLine(`IPC namespace: ${hash} (${workspacePath})`);

    // Handshake file: hands the MCP server this extension's real identity so
    // vscode:// URIs are built from the installed extension ID instead of a
    // hardcoded constant (the hardcoded-ID class of bug silently no-ops every
    // visualize_* call when the publisher/name ever changes), and so agents
    // can detect extension↔server version skew via get_usage_guide.
    try {
      const ipcDir = getWorkspaceIpcDir();
      ensureDir(ipcDir);
      fs.writeFileSync(path.join(ipcDir, 'extension-info.json'), JSON.stringify({
        extensionId: context.extension.id,
        uriScheme: vscode.env.uriScheme,
        version: context.extension.packageJSON.version,
        writtenAt: new Date().toISOString(),
      }, null, 2));
    } catch (err) {
      outputChannel.appendLine(`Could not write extension-info handshake: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Initialize cache with workspace state for persistence
  const cache = createExtensionCache(context.workspaceState);
  setCache(cache);

  // Initialize file watcher for cache invalidation
  const fileWatcher = createFileWatcher(cache);
  context.subscriptions.push(fileWatcher);

  console.log('Dendro cache and file watcher initialized');

  // Initialize license manager
  const licenseManager = new LicenseManager(context);
  licenseManagerInstance = licenseManager;
  licenseManager.initialize();
  console.log('Dendro license manager initialized');

  // Register CodeLens provider for "Used by X components"
  const codeLensProvider = new ComponentUsageCodeLensProvider();
  const codeLensRegistration = vscode.languages.registerCodeLensProvider(
    [
      { language: 'typescriptreact', scheme: 'file' },
      { language: 'javascriptreact', scheme: 'file' }
    ],
    codeLensProvider
  );
  context.subscriptions.push(codeLensRegistration);
  context.subscriptions.push(codeLensProvider);
  console.log('Dendro CodeLens provider registered');
  outputChannel.appendLine('CodeLens provider registered');

  // Register Component Tree View in sidebar
  ComponentTreeItem.extensionPath = context.extensionPath;
  const componentTreeProvider = new ComponentTreeProvider();
  const treeView = vscode.window.createTreeView('dendroReactComponentTree', {
    treeDataProvider: componentTreeProvider,
    showCollapseAll: true
  });
  context.subscriptions.push(treeView);
  context.subscriptions.push(componentTreeProvider);
  console.log('Dendro Component Tree view registered');
  outputChannel.appendLine('Component tree view registered');

  // First-run welcome notification (one-time)
  if (!context.globalState.get('dendro.hasShownWelcome')) {
    context.globalState.update('dendro.hasShownWelcome', true);
    vscode.window.showInformationMessage(
      'Dendro React installed! Open the sidebar to visualize your component tree, or set up MCP tools for AI-powered analysis.',
      'Get Started',
      'Report Issue'
    ).then((selection) => {
      if (selection === 'Get Started') {
        vscode.env.openExternal(vscode.Uri.parse('https://marketplace.visualstudio.com/items?itemName=RooneyTech.dendro-react'));
      } else if (selection === 'Report Issue') {
        vscode.env.openExternal(vscode.Uri.parse('https://github.com/RooneyTech/dendro-feedback/issues/new/choose'));
      }
    });
    outputChannel.appendLine('First-run welcome shown');
  }

  // Command: Report Issue
  const reportIssue = vscode.commands.registerCommand(
    'dendro-react.reportIssue',
    () => {
      vscode.env.openExternal(vscode.Uri.parse('https://github.com/RooneyTech/dendro-feedback/issues/new/choose'));
    }
  );
  context.subscriptions.push(reportIssue);

  // Command: Select root component for tree view
  const selectRootComponent = vscode.commands.registerCommand(
    'dendro-react.selectRootComponent',
    async () => {
      const options: DisposableOptions = {
        canSelectMany: false,
        openLabel: 'Select Root Component',
        filters: {
          'React Components': ['jsx', 'tsx']
        }
      };

      try {
        const fileUri = await vscode.window.showOpenDialog(options);
        if (fileUri && fileUri[0]) {
          componentTreeProvider.setRootFile(fileUri[0].fsPath);
          outputChannel.appendLine(`Root component set: ${fileUri[0].fsPath}`);
          vscode.window.showInformationMessage(`Root component set: ${path.basename(fileUri[0].fsPath)}`);
        }
      } catch (error) {
        console.error('Error selecting root component:', error);
        outputChannel.appendLine(`Error selecting root component: ${error}`);
        vscode.window.showErrorMessage(
          'Failed to select root component. Check the Output panel (Dendro React) for details.',
          'Report Issue'
        ).then((choice) => {
          if (choice === 'Report Issue') {
            vscode.commands.executeCommand('dendro-react.reportIssue');
          }
        });
      }
    }
  );
  context.subscriptions.push(selectRootComponent);

  // Command: Set current file as root (from context menu)
  const setAsRoot = vscode.commands.registerCommand(
    'dendro-react.setAsRoot',
    (fileUri?: vscode.Uri) => {
      let filePath: string | undefined;

      if (fileUri) {
        filePath = fileUri.fsPath;
      } else {
        // Use active editor if no URI provided
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          filePath = editor.document.fileName;
        }
      }

      if (filePath && /\.(tsx|jsx)$/.test(filePath)) {
        componentTreeProvider.setRootFile(filePath);
        vscode.window.showInformationMessage(`Root component set: ${path.basename(filePath)}`);
      } else {
        vscode.window.showWarningMessage('Please select a React component file (.tsx or .jsx)');
      }
    }
  );
  context.subscriptions.push(setAsRoot);

  // Command: Refresh tree view
  const refreshTree = vscode.commands.registerCommand(
    'dendro-react.refreshTree',
    () => {
      componentTreeProvider.refresh();
    }
  );
  context.subscriptions.push(refreshTree);

  // Command: Open component file (from tree item click)
  const openComponent = vscode.commands.registerCommand(
    'dendro-react.openComponent',
    async (filePath: string) => {
      if (filePath && fs.existsSync(filePath)) {
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc);
      }
    }
  );
  context.subscriptions.push(openComponent);

  // Command: Show component usage (triggered by clicking CodeLens)
  const showComponentUsage = vscode.commands.registerCommand(
    'dendro-react.showComponentUsage',
    async (componentName: string, files: string[], sourceFile: string) => {
      if (!files || files.length === 0) {
        vscode.window.showInformationMessage(`${componentName} is not used by any components`);
        return;
      }

      // Create quick pick items with file names and relative paths
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(sourceFile));
      const baseDir = workspaceFolder?.uri.fsPath || path.dirname(sourceFile);

      const items = files.map(filePath => {
        const relativePath = path.relative(baseDir, filePath);
        const fileName = path.basename(filePath);
        return {
          label: fileName,
          description: relativePath,
          filePath
        };
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Components using ${componentName} (${files.length} found)`,
        matchOnDescription: true
      });

      if (selected) {
        const doc = await vscode.workspace.openTextDocument(selected.filePath);
        await vscode.window.showTextDocument(doc);
      }
    }
  );
  context.subscriptions.push(showComponentUsage);

  // Create status bar item for quick access to visualization
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = "$(type-hierarchy) Dendro";
  statusBarItem.tooltip = "Visualize component tree";
  statusBarItem.command = "dendro-react.start";
  context.subscriptions.push(statusBarItem);

  // Update status bar visibility based on active editor file type
  function updateStatusBarVisibility() {
    const editor = vscode.window.activeTextEditor;
    if (editor && /\.(tsx|jsx)$/.test(editor.document.fileName)) {
      statusBarItem.show();
    } else {
      statusBarItem.hide();
    }
  }

  // Listen for active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateStatusBarVisibility)
  );

  // Initial visibility check
  updateStatusBarVisibility();

  // Update status bar with Pro status
  licenseManager.onStatusChange((status) => {
    if (status.isPro) {
      statusBarItem.text = '$(type-hierarchy) Dendro Pro';
      statusBarItem.tooltip = `Dendro Pro - ${status.plan || 'Active'}`;
    } else {
      statusBarItem.text = '$(type-hierarchy) Dendro';
      statusBarItem.tooltip = 'Visualize component tree';
    }
  });

  // --- License Commands ---

  const activateLicense = vscode.commands.registerCommand(
    'dendro-react.activateLicense',
    async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your Dendro Pro license key',
        placeHolder: 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX',
        password: true,
        ignoreFocusOut: true
      });
      if (!key) return;

      const result = await licenseManager.activate(key.trim());
      if (result.success) {
        vscode.window.showInformationMessage('Dendro Pro activated! All Pro features are now unlocked.');
      } else {
        vscode.window.showErrorMessage(`License activation failed: ${result.error}`);
      }
    }
  );
  context.subscriptions.push(activateLicense);

  const upgradeToPro = vscode.commands.registerCommand(
    'dendro-react.upgradeToPro',
    () => {
      vscode.env.openExternal(vscode.Uri.parse(licenseManager.getCheckoutUrl()));
    }
  );
  context.subscriptions.push(upgradeToPro);

  const manageSubscription = vscode.commands.registerCommand(
    'dendro-react.manageSubscription',
    () => {
      vscode.env.openExternal(vscode.Uri.parse(licenseManager.getPortalUrl()));
    }
  );
  context.subscriptions.push(manageSubscription);

  const deactivateLicense = vscode.commands.registerCommand(
    'dendro-react.deactivateLicense',
    async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Deactivate Dendro Pro on this machine?',
        'Deactivate',
        'Cancel'
      );
      if (confirm === 'Deactivate') {
        await licenseManager.deactivate();
        vscode.window.showInformationMessage('Dendro Pro deactivated.');
      }
    }
  );
  context.subscriptions.push(deactivateLicense);

  const showLicenseStatus = vscode.commands.registerCommand(
    'dendro-react.licenseStatus',
    () => {
      const status = licenseManager.getStatus();
      if (status.isPro) {
        vscode.window.showInformationMessage(
          `Dendro Pro - ${status.plan || 'Active'} | ${status.customerEmail || ''}` +
          (status.expiresAt ? ` | Expires: ${new Date(status.expiresAt).toLocaleDateString()}` : '')
        );
      } else {
        vscode.window.showInformationMessage(
          'Dendro Free — Upgrade to Pro for advanced exports and more.',
          'Upgrade'
        ).then((selection) => {
          if (selection === 'Upgrade') {
            vscode.commands.executeCommand('dendro-react.upgradeToPro');
          }
        });
      }
    }
  );
  context.subscriptions.push(showLicenseStatus);

  console.log('Dendro license commands registered');
  outputChannel.appendLine('License commands registered');

  // --- Runtime Connection (TICKET-030: Triggered Projection) ---

  const devToolsConnector = getDevToolsConnector();
  const sourceMapper = new SourceMapper();

  // Track runtime webview panels that should receive live tree updates
  const runtimeWebviewPanels: Set<{ panel: vscode.WebviewPanel; sessionId: string }> = new Set();

  // Track all webview panels for theme change propagation
  const allWebviewPanels: Set<vscode.WebviewPanel> = new Set();

  // Detect VS Code theme and propagate changes to webviews
  function isDarkTheme(): boolean {
    const kind = vscode.window.activeColorTheme.kind;
    return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => {
      const darkMode = isDarkTheme();
      for (const panel of allWebviewPanels) {
        panel.webview.postMessage({ type: 'themeChanged', darkMode });
      }
    })
  );

  // Projector mode: toggle and broadcast to all webviews
  const projectorModeCmd = vscode.commands.registerCommand('dendro-react.projectorMode', async () => {
    const config = vscode.workspace.getConfiguration('dendro-react');
    const current = config.get<boolean>('projectorMode', false);
    await config.update('projectorMode', !current, vscode.ConfigurationTarget.Global);
    for (const panel of allWebviewPanels) {
      panel.webview.postMessage({ type: 'projectorModeChanged', projectorMode: !current });
    }
    vscode.window.showInformationMessage(`Dendro: Projector mode ${!current ? 'ON' : 'OFF'}`);
  });
  context.subscriptions.push(projectorModeCmd);

  // Create runtime connection status bar item
  const runtimeStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99
  );
  runtimeStatusBar.command = 'dendro-react.connectRuntime';
  context.subscriptions.push(runtimeStatusBar);

  function updateRuntimeStatusBar(status: ConnectionStatus): void {
    switch (status) {
      case 'disconnected':
        runtimeStatusBar.text = '$(plug) Dendro: Disconnected';
        runtimeStatusBar.tooltip = 'Click to start listening for React Native app';
        runtimeStatusBar.backgroundColor = undefined;
        runtimeStatusBar.command = 'dendro-react.connectRuntime';
        break;
      case 'listening':
        runtimeStatusBar.text = '$(radio-tower) Dendro: Listening...';
        runtimeStatusBar.tooltip = 'Waiting for React Native app to connect on port 8097';
        runtimeStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        runtimeStatusBar.command = 'dendro-react.disconnectRuntime';
        break;
      case 'connected':
        runtimeStatusBar.text = '$(check) Dendro: Connected';
        runtimeStatusBar.tooltip = 'Connected to React Native app - receiving live tree updates';
        runtimeStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
        runtimeStatusBar.command = 'dendro-react.disconnectRuntime';
        break;
    }
  }

  // Initialize status bar
  updateRuntimeStatusBar('disconnected');
  runtimeStatusBar.show();

  // Runtime listener setup (with platform-specific config)
  const dendroConfig = vscode.workspace.getConfiguration('dendro-react');
  const runtimePlatform = dendroConfig.get<string>('runtimePlatform', 'auto');
  const runtimePort = dendroConfig.get<number>('runtimePort', 8097);
  let runtimeHost = dendroConfig.get<string>('runtimeHost', 'localhost');
  const autoStartRuntime = dendroConfig.get<boolean>('autoStartRuntime', false);

  // Device mode: force listen on 0.0.0.0 so physical devices can connect
  if (runtimePlatform === 'device') {
    runtimeHost = '0.0.0.0';
  }

  // Apply port/host config if non-default — recreate connector with custom config
  if (runtimePort !== 8097 || runtimeHost !== 'localhost') {
    console.log(`Dendro: Using custom runtime config: ${runtimeHost}:${runtimePort}`);
    // The connector was created with defaults; we need to update its config
    // Since the constructor is already called, we'll use the config properties directly
    (devToolsConnector as any).config = { port: runtimePort, host: runtimeHost };
  }

  // Only auto-start if user has opted in — prevents port conflict errors
  if (autoStartRuntime) {
    devToolsConnector.start().then(async () => {
      console.log(`Dendro: Auto-started runtime listener on ${runtimeHost}:${runtimePort}`);

      // Set up ADB reverse tunnel for Android
      if (runtimePlatform === 'android') {
        const success = await devToolsConnector.setupAdbReverse(false);
        if (success) {
          vscode.window.showInformationMessage('Dendro: ADB reverse tunnel established for Android emulator');
        }
      } else if (runtimePlatform === 'auto') {
        // Silently try ADB — no error if not available
        await devToolsConnector.setupAdbReverse(true);
      }
    }).catch((error) => {
      console.error('Dendro: Failed to auto-start runtime listener:', error);
    });
  }

  // Listen for connection status changes
  devToolsConnector.on('status-change', (status: ConnectionStatus) => {
    console.log(`Dendro: Runtime connection status: ${status}`);
    outputChannel.appendLine(`Runtime connection: ${status}`);
    updateRuntimeStatusBar(status);

    if (status === 'connected') {
      vscode.window.showInformationMessage('Dendro: Connected to React Native app');

      // Build source index for runtime-to-source mapping
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceRoot) {
        sourceMapper.buildIndex(workspaceRoot);
        componentTreeProvider.setSourceMap(sourceMapper.getSourceMap());
        console.log(`Dendro: Source mapper indexed ${sourceMapper.size} components`);
      }
    } else if (status === 'disconnected' || status === 'listening') {
      // Clear runtime tree and state file when disconnected
      componentTreeProvider.clearRuntimeTree();
      clearRuntimeState();

      // Notify runtime webview panels of disconnection
      for (const entry of runtimeWebviewPanels) {
        entry.panel.webview.postMessage({
          type: 'runtimeStatus',
          payload: { status },
        });
      }
    }
  });

  // Listen for tree updates
  devToolsConnector.on('tree-update', (tree: RuntimeTree) => {
    const componentCount = tree.elements.size;
    const rootCount = tree.roots.length;
    console.log(`Dendro: Runtime tree updated - ${componentCount} components, ${rootCount} roots, rootIDs: [${tree.roots.join(', ')}]`);
    if (componentCount > 0) {
      const firstFew = Array.from(tree.elements.values()).slice(0, 5);
      console.log(`Dendro: First elements: ${firstFew.map(e => `${e.id}:${e.displayName}(${e.type})`).join(', ')}`);
    }

    // Update sidebar tree view with runtime data
    componentTreeProvider.setRuntimeTree(tree);

    // Write runtime state to disk for MCP server (debounced)
    writeRuntimeState(tree, sourceMapper.getSourceMap());

    // Push runtime tree to all active runtime webview panels
    if (runtimeWebviewPanels.size > 0) {
      const hierarchy = buildRuntimeHierarchy(tree, sourceMapper.getSourceMap());
      for (const entry of runtimeWebviewPanels) {
        entry.panel.webview.postMessage({
          type: 'runtimeTreeData',
          payload: {
            treeData: hierarchy,
            componentCount,
            sessionId: entry.sessionId,
          },
        });
      }
    }
  });

  // Listen for errors — log all, but only show a warning (not error) toast.
  // The connector deduplicates identical messages, so EADDRINUSE won't spam.
  devToolsConnector.on('error', (error: Error) => {
    console.error('Dendro: Runtime connection error:', error);
    const msg = error.message;
    if (msg.includes('EADDRINUSE')) {
      vscode.window.showWarningMessage(
        `Dendro: Port ${(devToolsConnector as any).config?.port ?? 8097} is in use. Try fully quitting VS Code (Cmd+Q) and reopening, or check for Expo DevTools on the same port.`
      );
    } else {
      vscode.window.showWarningMessage(`Dendro runtime: ${msg}`);
    }
  });

  // When retries are exhausted, show a single clear message
  devToolsConnector.on('max-retries-exhausted', (attempts: number) => {
    vscode.window.showWarningMessage(
      `Dendro: Could not bind runtime port after ${attempts} attempts. Use "Dendro: Connect to Runtime" to retry.`
    );
  });

  // Command: Connect to runtime
  const connectRuntime = vscode.commands.registerCommand(
    'dendro-react.connectRuntime',
    async () => {
      if (devToolsConnector.status !== 'disconnected') {
        vscode.window.showInformationMessage('Dendro: Already connected or listening');
        return;
      }

      try {
        // Apply current settings before starting
        const cfg = vscode.workspace.getConfiguration('dendro-react');
        const port = cfg.get<number>('runtimePort', 8097);
        const platform = cfg.get<string>('runtimePlatform', 'auto');
        let host = cfg.get<string>('runtimeHost', 'localhost');
        if (platform === 'device') host = '0.0.0.0';
        (devToolsConnector as any).config = { port, host };

        await devToolsConnector.start();

        // Set up ADB if needed
        if (platform === 'android') {
          const success = await devToolsConnector.setupAdbReverse(false);
          if (success) {
            vscode.window.showInformationMessage('Dendro: ADB reverse tunnel established');
          }
        } else if (platform === 'auto') {
          await devToolsConnector.setupAdbReverse(true);
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Dendro: Failed to start runtime server: ${error}`);
      }
    }
  );
  context.subscriptions.push(connectRuntime);

  // Command: Disconnect from runtime
  const disconnectRuntime = vscode.commands.registerCommand(
    'dendro-react.disconnectRuntime',
    async () => {
      if (devToolsConnector.status === 'disconnected') {
        vscode.window.showInformationMessage('Dendro: Not connected');
        return;
      }

      try {
        await devToolsConnector.stop();
        vscode.window.showInformationMessage('Dendro: Disconnected from runtime');
      } catch (error) {
        vscode.window.showErrorMessage(`Dendro: Failed to stop runtime server: ${error}`);
      }
    }
  );
  context.subscriptions.push(disconnectRuntime);

  // Command: Inspect a runtime component (triggered by clicking unresolved RuntimeTreeItem)
  const inspectRuntimeComponent = vscode.commands.registerCommand(
    'dendro-react.inspectRuntimeComponent',
    async (runtimeId: number) => {
      if (devToolsConnector.status !== 'connected') {
        vscode.window.showWarningMessage('Dendro: Not connected to a running app');
        return;
      }

      const component = devToolsConnector.getComponent(runtimeId);
      if (!component) {
        vscode.window.showWarningMessage(`Dendro: Component ${runtimeId} not found`);
        return;
      }

      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Inspecting ${component.displayName}...` },
        async () => {
          const result = await devToolsConnector.inspectElement(runtimeId);
          if (result) {
            componentTreeProvider.setInspectionResult(result);
          } else {
            vscode.window.showWarningMessage(`Dendro: Failed to inspect ${component.displayName} (timeout)`);
          }
        }
      );
    }
  );
  context.subscriptions.push(inspectRuntimeComponent);

  // Inspect Bridge: Watch for MCP inspect requests and fulfill via DevToolsConnector
  // Polls ~/.dendro/inspect-request.json every 300ms. When a request arrives,
  // calls inspectElement() and writes the result to ~/.dendro/inspect-result.json.
  let lastProcessedRequestId: string | null = null;
  const inspectBridgeInterval = setInterval(async () => {
    const request = readInspectRequest();
    if (!request || request.requestId === lastProcessedRequestId) return;

    lastProcessedRequestId = request.requestId;
    console.log(`Dendro: Inspect bridge received request for element ${request.elementId} (${request.componentName})`);

    if (devToolsConnector.status !== 'connected') {
      const errorResult: InspectResult = {
        requestId: request.requestId,
        elementId: request.elementId,
        componentName: request.componentName,
        props: {},
        state: null,
        hooks: null,
        context: null,
        timestamp: Date.now(),
        success: false,
        error: 'Not connected to a running app',
      };
      writeInspectResult(errorResult);
      clearInspectRequest();
      return;
    }

    try {
      const inspected = await devToolsConnector.inspectElement(request.elementId);

      if (inspected) {
        const result: InspectResult = {
          requestId: request.requestId,
          elementId: inspected.id,
          componentName: inspected.displayName || request.componentName,
          props: inspected.props || {},
          state: inspected.state || null,
          hooks: (inspected.hooks || []).map(h => ({
            id: h.id,
            name: h.name,
            value: h.value,
            subHooks: h.subHooks || [],
          })),
          context: inspected.context || null,
          timestamp: Date.now(),
          success: true,
        };
        writeInspectResult(result);
      } else {
        const errorResult: InspectResult = {
          requestId: request.requestId,
          elementId: request.elementId,
          componentName: request.componentName,
          props: {},
          state: null,
          hooks: null,
          context: null,
          timestamp: Date.now(),
          success: false,
          error: `inspectElement returned null (timeout or component not found)`,
        };
        writeInspectResult(errorResult);
      }

      clearInspectRequest();
    } catch (err) {
      console.error('Dendro: Inspect bridge error:', err);
      const errorResult: InspectResult = {
        requestId: request.requestId,
        elementId: request.elementId,
        componentName: request.componentName,
        props: {},
        state: null,
        hooks: null,
        context: null,
        timestamp: Date.now(),
        success: false,
        error: `Inspection failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      writeInspectResult(errorResult);
      clearInspectRequest();
    }
  }, 300);

  context.subscriptions.push({ dispose: () => clearInterval(inspectBridgeInterval) });

  // Override Bridge: Watch for MCP override requests and fulfill via DevToolsConnector
  // Same pattern as inspect bridge: polls ~/.dendro/override-request.json every 300ms.
  let lastProcessedOverrideId: string | null = null;
  const overrideBridgeInterval = setInterval(async () => {
    const request = readOverrideRequest();
    if (!request || request.requestId === lastProcessedOverrideId) return;

    lastProcessedOverrideId = request.requestId;
    console.log(`Dendro: Override bridge received request for element ${request.elementId} (${request.componentName}), type=${request.type}, path=[${request.path.join('.')}]`);

    if (devToolsConnector.status !== 'connected') {
      const errorResult: OverrideResult = {
        requestId: request.requestId,
        elementId: request.elementId,
        componentName: request.componentName,
        type: request.type,
        path: request.path,
        value: request.value,
        timestamp: Date.now(),
        success: false,
        error: 'Not connected to a running app',
      };
      writeOverrideResult(errorResult);
      clearOverrideRequest();
      return;
    }

    try {
      const success = devToolsConnector.overrideValueAtPath(
        request.elementId,
        request.type,
        request.path,
        request.value,
        request.hookID
      );

      const result: OverrideResult = {
        requestId: request.requestId,
        elementId: request.elementId,
        componentName: request.componentName,
        type: request.type,
        path: request.path,
        value: request.value,
        timestamp: Date.now(),
        success,
        error: success ? undefined : 'Failed to send override (not connected)',
      };
      writeOverrideResult(result);
      clearOverrideRequest();
    } catch (err) {
      console.error('Dendro: Override bridge error:', err);
      const errorResult: OverrideResult = {
        requestId: request.requestId,
        elementId: request.elementId,
        componentName: request.componentName,
        type: request.type,
        path: request.path,
        value: request.value,
        timestamp: Date.now(),
        success: false,
        error: `Override failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      writeOverrideResult(errorResult);
      clearOverrideRequest();
    }
  }, 300);

  context.subscriptions.push({ dispose: () => clearInterval(overrideBridgeInterval) });

  // Command: Show live runtime tree in webview visualizer
  const showRuntimeTree = vscode.commands.registerCommand(
    'dendro-react.showRuntimeTree',
    () => {
      // CRITICAL: These paths MUST use 'dist/' (webpack bundle), NOT 'out/'
      const panel = vscode.window.createWebviewPanel(
        'dendroRuntimeTree',
        'Dendro: Live Runtime Tree',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'dist'))],
        }
      );

      const sessionId = webviewRegistry.registerPanel(panel, '__runtime__');
      console.log(`Dendro: Registered runtime webview session ${sessionId}`);

      const webviewJsPath = vscode.Uri.file(
        path.join(context.extensionPath, 'dist', 'webview.js')
      );
      const webviewJsUri = panel.webview.asWebviewUri(webviewJsPath);
      const runtimeFontUris = getFontUris(panel.webview, context.extensionPath);

      panel.webview.html = getRuntimeWebviewContent(webviewJsUri, sessionId, runtimeFontUris);

      const entry = { panel, sessionId };
      runtimeWebviewPanels.add(entry);
      allWebviewPanels.add(panel);

      panel.onDidDispose(() => {
        runtimeWebviewPanels.delete(entry);
        allWebviewPanels.delete(panel);
      });

      panel.webview.onDidReceiveMessage(async (message) => {
        if (message.type === 'visualizerReady') {
          console.log(`Dendro: Runtime webview ${sessionId} reported ready`);
          webviewRegistry.markReady(sessionId);

          // Send current tree immediately if connected
          if (devToolsConnector.status === 'connected') {
            const allComponents = devToolsConnector.getAllComponents();
            const rootComponents = devToolsConnector.getTreeHierarchy();
            const tree: RuntimeTree = {
              roots: rootComponents.map(c => c.id),
              elements: new Map(allComponents.map(c => [c.id, c])),
              rendererVersion: null,
            };
            const hierarchy = buildRuntimeHierarchy(tree, sourceMapper.getSourceMap());
            panel.webview.postMessage({
              type: 'runtimeTreeData',
              payload: {
                treeData: hierarchy,
                componentCount: allComponents.length,
                sessionId,
              },
            });
          } else {
            panel.webview.postMessage({
              type: 'runtimeStatus',
              payload: { status: devToolsConnector.status },
            });
          }
        } else if (message.type === 'inspectComponent') {
          // Runtime node clicked — trigger inspect
          const runtimeId = message.runtimeId;
          if (runtimeId && typeof runtimeId === 'number') {
            vscode.commands.executeCommand('dendro-react.inspectRuntimeComponent', runtimeId);
          }
        } else if (message.type === 'openSourceFile') {
          // Open source file for a runtime component
          const filePath = message.filePath;
          if (filePath && fs.existsSync(filePath)) {
            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
          }
        } else if (message.type === 'commandResponse') {
          console.log(`Dendro: Command response from runtime webview ${sessionId}:`, message.response);
        } else if (message.type === 'webviewError') {
          console.error(`Dendro: runtime webview ${sessionId} reported ${message.kind}:`, message.message, message.stack ?? '');
          recordWebviewError({
            kind: String(message.kind ?? 'error'),
            message: String(message.message ?? 'unknown'),
            stack: message.stack ? String(message.stack) : undefined,
            sessionId,
          });
        }
      }, undefined, context.subscriptions);
    }
  );
  context.subscriptions.push(showRuntimeTree);

  // Clean up connector and runtime state on deactivation
  context.subscriptions.push({
    dispose: () => {
      devToolsConnector.stop();
      clearRuntimeState();
      clearVisualizerStatus();
    }
  });

  console.log('Dendro: Runtime connector initialized');

  // Helper function to open visualization for a given file path
  // CRITICAL: Uses 'dist/' paths - see .dev/HANDOFF.md "Extension Packaging Architecture"
  function openVisualization(filePath: string) {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);

    if (!fs.existsSync(absolutePath)) {
      vscode.window.showErrorMessage(`File not found: ${absolutePath}`);
      return;
    }

    const baseDir = path.dirname(absolutePath);
    const compName = path.parse(absolutePath).base;

    const tree = buildComponentTree(absolutePath, baseDir);
    if (!tree) {
      outputChannel.appendLine(`Failed to parse component tree: ${absolutePath}`);
      vscode.window.showErrorMessage(
        'Failed to parse component tree. The file may not be a valid React component.',
        'Report Issue'
      ).then((choice) => {
        if (choice === 'Report Issue') {
          vscode.commands.executeCommand('dendro-react.reportIssue');
        }
      });
      return;
    }

    // CRITICAL: These paths MUST use 'dist/' (webpack bundle), NOT 'out/'
    const panel = vscode.window.createWebviewPanel(
      'dendrogram',
      `Component Tree: ${compName}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'dist'))]
      }
    );

    // Register panel with webview registry for AI control
    const sessionId = webviewRegistry.registerPanel(panel, absolutePath);
    console.log(`Dendro: Registered webview session ${sessionId} for ${compName}`);

    const webviewJsPath = vscode.Uri.file(
      path.join(context.extensionPath, 'dist', 'webview.js')  // NOT 'out/webview/webview.js'
    );
    const webviewJsUri = panel.webview.asWebviewUri(webviewJsPath);

    // Font URIs for webview
    const fontUris = getFontUris(panel.webview, context.extensionPath);

    console.log(`Loading Webview for ${compName}`);
    panel.webview.html = getWebviewContent(compName, webviewJsUri, sessionId, fontUris);

    allWebviewPanels.add(panel);
    panel.onDidDispose(() => {
      allWebviewPanels.delete(panel);
    });

    panel.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'requestData') {
        context.workspaceState.update('dendro', tree);
        panel.webview.postMessage({
          type: 'astData',
          payload: {
            treeData: tree,
            filePath: absolutePath,
            sessionId
          },
          settings: vscode.workspace.getConfiguration('dendro-react')
        }).then(() => console.log("Posted astData with filePath"));
      } else if (message.type === 'visualizerReady') {
        console.log(`Dendro: Webview ${sessionId} reported ready`);
        webviewRegistry.markReady(sessionId);
        writeVisualizerReady(sessionId, absolutePath);
      } else if (message.type === 'openSourceFile') {
        const filePath = message.filePath;
        const resolved = path.isAbsolute(filePath)
          ? filePath
          : path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', filePath);
        if (fs.existsSync(resolved)) {
          const doc = await vscode.workspace.openTextDocument(resolved);
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        }
      } else if (message.type === 'commandResponse') {
        console.log(`Dendro: Command response from ${sessionId}:`, message.response);
      }
    }, undefined, context.subscriptions);
  }

  const dendroStart = vscode.commands.registerCommand('dendro-react.start', async () => {
    const options: DisposableOptions = {
      canSelectMany: false,
      openLabel: 'Select React Component',
      filters: {
        'React Components': ['jsx', 'tsx']
      }
    };

    try {
      const fileUri = await vscode.window.showOpenDialog(options);
      if (fileUri && fileUri[0]) {
        openVisualization(fileUri[0].fsPath);
      }
    } catch (error) {
      console.error('Error during command execution:', error);
      outputChannel.appendLine(`Error in dendro-react.start: ${error}`);
      vscode.window.showErrorMessage(
        'Failed to open visualization. Check the Output panel (Dendro React) for details.',
        'Report Issue'
      ).then((choice) => {
        if (choice === 'Report Issue') {
          vscode.commands.executeCommand('dendro-react.reportIssue');
        }
      });
    }
  });

  // Command: dendro.visualize - Takes file path as argument, or uses active editor, or falls back to file picker
  const dendroVisualize = vscode.commands.registerCommand('dendro-react.visualize', (filePathOrUri?: string | vscode.Uri) => {
    let filePath: string | undefined;

    if (filePathOrUri instanceof vscode.Uri) {
      filePath = filePathOrUri.fsPath;
    } else {
      filePath = filePathOrUri;
    }

    // If no path provided, try the active editor
    if (!filePath) {
      const editor = vscode.window.activeTextEditor;
      if (editor && /\.(tsx|jsx)$/.test(editor.document.fileName)) {
        filePath = editor.document.fileName;
      }
    }

    if (!filePath) {
      // Fall back to file picker
      vscode.commands.executeCommand('dendro-react.start');
      return;
    }
    openVisualization(filePath);
  });

  // URI Handler: vscode://dendro-mcp.dendro-mcp/visualize?file=/path/to/file.tsx
  // Also handles visualization commands from MCP tools (running in separate process)

  /**
   * Validate that a file path from a URI parameter falls within the current workspace.
   * Prevents path traversal attacks via crafted vscode:// URIs.
   * Returns the resolved absolute path on success, or undefined on failure.
   */
  function validateUriPath(filePath: string, paramName: string): string | undefined {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    let resolvedPath: string;
    try {
      resolvedPath = fs.existsSync(absolutePath) ? fs.realpathSync(absolutePath) : absolutePath;
    } catch {
      console.warn(`Dendro URI: Cannot resolve path for ${paramName}: ${absolutePath}`);
      return undefined;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      console.warn(`Dendro URI: No workspace folders — rejecting ${paramName}: ${resolvedPath}`);
      vscode.window.showErrorMessage('Dendro: No workspace open. Cannot process URI.');
      return undefined;
    }

    const inWorkspace = folders.some(folder => {
      const root = fs.realpathSync(folder.uri.fsPath);
      return resolvedPath === root || resolvedPath.startsWith(root + path.sep);
    });

    if (!inWorkspace) {
      console.warn(`Dendro URI: Path outside workspace boundary — rejecting ${paramName}: ${resolvedPath}`);
      vscode.window.showErrorMessage(`Dendro: Access denied — "${path.basename(resolvedPath)}" is outside the workspace.`);
      return undefined;
    }

    return resolvedPath;
  }

  const uriHandler: vscode.UriHandler = {
    handleUri(uri: vscode.Uri) {
      console.log('=== Dendro URI Handler ===');
      console.log('Full URI:', uri.toString());
      console.log('Path:', uri.path);
      console.log('Query:', uri.query);

      const params = new URLSearchParams(uri.query);

      /**
       * Auto-open helper: if no webview session exists and entryFile is provided,
       * open the visualizer first. The command will be queued by webview-bridge
       * and flushed when the webview reports ready.
       */
      function ensureVisualizerOpen(params: URLSearchParams): void {
        if (!webviewRegistry.hasActiveSessions()) {
          const entryFile = params.get('entryFile');
          if (entryFile) {
            const decoded = decodeURIComponent(entryFile);
            const validated = validateUriPath(decoded, 'entryFile');
            if (!validated) return;
            console.log(`Dendro URI: Auto-opening visualizer for ${validated}`);
            openVisualization(validated);
          } else {
            console.warn('Dendro URI: No active webview and no entryFile provided. Command may be lost.');
          }
        }
      }

      // Route based on path
      switch (uri.path) {
        case '/visualize':
        case '/open':
        case '/tree':
        case '/':
        case '': {
          const filePath = params.get('file');
          if (filePath) {
            const decoded = decodeURIComponent(filePath);
            const validated = validateUriPath(decoded, 'file');
            if (!validated) break;
            openVisualization(validated);
          } else {
            vscode.window.showErrorMessage('Dendro: No file parameter provided in URI');
          }
          break;
        }

        case '/highlight': {
          ensureVisualizerOpen(params);
          const nodes = params.get('nodes')?.split(',') || [];
          const color = (params.get('color') || 'red') as 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';
          const label = params.get('label') || undefined;
          const pulse = params.get('pulse') !== 'false';
          const duration = params.get('duration') ? parseInt(params.get('duration')!, 10) : 0;
          const sessionId = params.get('sessionId') || undefined;

          const command = {
            type: 'highlight' as const,
            payload: { nodes, color, label, pulse, duration }
          };

          const success = webviewRegistry.sendCommand(sessionId, command);
          console.log(`Dendro URI: highlight ${nodes.length} nodes with ${color}, success=${success}`);
          break;
        }

        case '/zoom': {
          ensureVisualizerOpen(params);
          const targetParam = params.get('target') || '';
          const target = targetParam.includes(',') ? targetParam.split(',') : targetParam;
          const padding = params.get('padding') ? parseInt(params.get('padding')!, 10) : 50;
          const duration = params.get('duration') ? parseInt(params.get('duration')!, 10) : 750;
          const sessionId = params.get('sessionId') || undefined;

          const command = {
            type: 'zoom' as const,
            payload: { target, padding, duration }
          };

          const success = webviewRegistry.sendCommand(sessionId, command);
          console.log(`Dendro URI: zoom to ${target}, success=${success}`);
          break;
        }

        case '/annotate': {
          ensureVisualizerOpen(params);
          const nodeId = params.get('nodeId') || '';
          const text = params.get('text') || '';
          const position = (params.get('position') || 'right') as 'top' | 'right' | 'bottom' | 'left';
          const style = (params.get('style') || 'callout') as 'callout' | 'badge' | 'tooltip';
          const color = params.get('color') || undefined;
          const sessionId = params.get('sessionId') || undefined;

          const command = {
            type: 'annotate' as const,
            payload: { nodeId, text, position, style, color }
          };

          const success = webviewRegistry.sendCommand(sessionId, command);
          console.log(`Dendro URI: annotate ${nodeId} with "${text}", success=${success}`);
          break;
        }

        case '/trace-flow': {
          ensureVisualizerOpen(params);
          const nodes = params.get('nodes')?.split(',') || [];
          const label = params.get('label') || undefined;
          const color = params.get('color') || '#ff4444';
          const animated = params.get('animated') !== 'false';
          const flowType = (params.get('flowType') || 'prop') as 'prop' | 'state' | 'context' | 'event';
          const sessionId = params.get('sessionId') || undefined;

          const command = {
            type: 'traceFlow' as const,
            payload: { nodes, label, color, animated, flowType }
          };

          const success = webviewRegistry.sendCommand(sessionId, command);
          console.log(`Dendro URI: trace flow through ${nodes.length} nodes, success=${success}`);
          break;
        }

        case '/clear': {
          const clearType = (params.get('type') || 'all') as 'highlights' | 'annotations' | 'flows' | 'all';
          const ids = params.get('ids')?.split(',') || undefined;
          const sessionId = params.get('sessionId') || undefined;

          const command = {
            type: 'clear' as const,
            payload: { clearType, ids }
          };

          const success = webviewRegistry.sendCommand(sessionId, command);
          console.log(`Dendro URI: clear ${clearType}, success=${success}`);
          break;
        }

        case '/expand': {
          const nodeId = params.get('nodeId') || '';
          const recursive = params.get('recursive') === 'true';
          const sessionId = params.get('sessionId') || undefined;

          const command = {
            type: 'expand' as const,
            payload: { nodeId, recursive }
          };

          const success = webviewRegistry.sendCommand(sessionId, command);
          console.log(`Dendro URI: expand ${nodeId}, success=${success}`);
          break;
        }

        case '/collapse': {
          const nodeId = params.get('nodeId') || '';
          const sessionId = params.get('sessionId') || undefined;

          const command = {
            type: 'collapse' as const,
            payload: { nodeId }
          };

          const success = webviewRegistry.sendCommand(sessionId, command);
          console.log(`Dendro URI: collapse ${nodeId}, success=${success}`);
          break;
        }

        case '/fit-all': {
          ensureVisualizerOpen(params);
          const duration = params.get('duration') ? parseInt(params.get('duration')!, 10) : 1500;
          const padding = params.get('padding') ? parseInt(params.get('padding')!, 10) : 60;
          const sessionId = params.get('sessionId') || undefined;

          const command = {
            type: 'fitAll' as const,
            payload: { duration, padding }
          };

          const success = webviewRegistry.sendCommand(sessionId, command);
          console.log(`Dendro URI: fit-all duration=${duration}, success=${success}`);
          break;
        }

        case '/batch': {
          ensureVisualizerOpen(params);
          const sessionId = params.get('sessionId') || undefined;
          const delay = parseInt(params.get('delay') || '0', 10);
          const waitForUser = params.get('waitForUser') === 'true';

          try {
            const commandsJson = params.get('commands') || '[]';
            const commands = JSON.parse(commandsJson) as Array<{ type: string; payload?: Record<string, unknown>; label?: string }>;

            if (waitForUser) {
              // Manual advance — send all commands at once, webview shows "Next" button
              webviewRegistry.sendBatch(sessionId, commands, true);
              console.log(`Dendro URI: batch ${commands.length} commands, waitForUser=true, success=true`);
            } else {
              // Auto-play with delay spacing
              commands.forEach((cmd, i) => {
                const sendCmd = () => {
                  webviewRegistry.sendCommand(sessionId, {
                    type: cmd.type,
                    payload: cmd.payload || {}
                  } as import('./webview-bridge').VisualizationCommand);
                };
                if (delay > 0 && i > 0) {
                  setTimeout(sendCmd, delay * i);
                } else {
                  sendCmd();
                }
              });
              console.log(`Dendro URI: batch ${commands.length} commands, delay=${delay}ms, success=true`);
            }
          } catch (err) {
            console.error('Dendro URI: batch parse error:', err);
          }
          break;
        }

        case '/start-tour': {
          ensureVisualizerOpen(params);

          try {
            const { readTourConfig, clearTourConfig } = require('../runtime/tour-bridge');
            const tourConfig = readTourConfig();
            clearTourConfig();

            if (tourConfig) {
              const sessionId = params.get('sessionId') || undefined;
              webviewRegistry.sendCommand(sessionId, {
                type: 'startTour',
                payload: { tourConfig }
              } as import('./webview-bridge').VisualizationCommand);
              console.log(`Dendro URI: start-tour "${tourConfig.title}", ${tourConfig.steps?.length || 0} steps`);
            } else {
              console.warn('Dendro URI: start-tour — no tour config found');
            }
          } catch (err) {
            console.error('Dendro URI: start-tour error:', err);
          }
          break;
        }

        default:
          vscode.window.showErrorMessage(`Dendro: Unknown URI path: ${uri.path}`);
      }
    }
  };

  // Command: Test URI handler (for debugging)
  const testUri = vscode.commands.registerCommand('dendro-react.testUri', async () => {
    const testPath = await vscode.window.showInputBox({
      prompt: 'Enter file path to test URI handler',
      value: vscode.window.activeTextEditor?.document.fileName || ''
    });

    if (testPath) {
      console.log('Dendro testUri: simulating URI handler for:', testPath);
      openVisualization(testPath);
      vscode.window.showInformationMessage(`URI handler test: visualizing ${testPath}`);
    }
  });

  context.subscriptions.push(dendroStart);
  context.subscriptions.push(dendroVisualize);
  context.subscriptions.push(testUri);
  context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));
  console.log('Dendro URI handler registered');

  interface FontUris {
    spaceGrotesk500: vscode.Uri;
    spaceGrotesk700: vscode.Uri;
    jetBrainsMono400: vscode.Uri;
  }

  function getFontUris(webview: vscode.Webview, extensionPath: string): FontUris {
    return {
      spaceGrotesk500: webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'dist', 'fonts', 'space-grotesk-500.woff2'))),
      spaceGrotesk700: webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'dist', 'fonts', 'space-grotesk-700.woff2'))),
      jetBrainsMono400: webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'dist', 'fonts', 'jetbrains-mono-400.woff2'))),
    };
  }

  function fontFaceCSS(fonts: FontUris): string {
    return `
      @font-face {
        font-family: 'Space Grotesk';
        font-style: normal;
        font-weight: 500;
        font-display: swap;
        src: url('${fonts.spaceGrotesk500}') format('woff2');
      }
      @font-face {
        font-family: 'Space Grotesk';
        font-style: normal;
        font-weight: 700;
        font-display: swap;
        src: url('${fonts.spaceGrotesk700}') format('woff2');
      }
      @font-face {
        font-family: 'JetBrains Mono';
        font-style: normal;
        font-weight: 400;
        font-display: swap;
        src: url('${fonts.jetBrainsMono400}') format('woff2');
      }
    `;
  }

  function getWebviewContent(compName: string, uri: vscode.Uri, sessionId: string, fonts?: FontUris): string {
    const darkMode = isDarkTheme();
    const fontCSS = fonts ? fontFaceCSS(fonts) : '';
    const nonce = crypto.randomBytes(16).toString('base64');
    const fontSources = fonts
      ? `${fonts.spaceGrotesk500} ${fonts.spaceGrotesk700} ${fonts.jetBrainsMono400}`
      : '';
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; font-src ${fontSources}; img-src data:;">
          <title>Component Tree: ${compName}</title>
          <style>
            ${fontCSS}
            *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
            html, body { width: 100%; height: 100%; overflow: hidden; }
            body { font-family: 'Space Grotesk', Inter, 'IBM Plex Sans', system-ui, -apple-system, sans-serif; }
            #root { width: 100%; height: 100%; }
          </style>
      </head>
      <body>
        <div id="root"></div>
        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          window.dendroSessionId = '${sessionId}';
          window.dendroInitialTheme = '${darkMode ? 'dark' : 'light'}';
          window.dendroProjectorMode = ${vscode.workspace.getConfiguration('dendro-react').get<boolean>('projectorMode', false)};
          // Report uncaught errors to the extension (-> local telemetry) and show a
          // non-destructive banner. Never touch #root: it is React's container, and
          // wiping it turns the first error into an uncaught removeChild crash that
          // masks the original message (TOUR-BUG-REPORT.md Bug 3).
          const dendroReportError = (kind, msg, stack) => {
            console.error('Dendro webview ' + kind + ':', msg, stack || '');
            try {
              vscode.postMessage({ type: 'webviewError', kind, message: String(msg), stack: stack ? String(stack) : undefined, sessionId: window.dendroSessionId });
            } catch (_) { /* posting must never throw */ }
            let el = document.getElementById('dendro-error-banner');
            if (!el) {
              el = document.createElement('div');
              el.id = 'dendro-error-banner';
              el.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9999;background:rgba(45,0,0,0.95);color:#ff6b6b;padding:8px 12px;font:12px monospace;';
              document.body.appendChild(el);
            }
            el.textContent = 'Dendro error: ' + msg;
          };
          window.onerror = (msg, url, line, col, err) => { dendroReportError('error', msg, err && err.stack); };
          window.onunhandledrejection = (e) => {
            const r = e && e.reason;
            dendroReportError('unhandledrejection', (r && r.message) || String(r), r && r.stack);
          };
          window.onload = () => {
            vscode.postMessage({ type: 'requestData' });
          };
        </script>
        <script nonce="${nonce}" src="${uri}"></script>
      </body>
      </html>
    `;
  }

  function getRuntimeWebviewContent(uri: vscode.Uri, sessionId: string, fonts?: FontUris): string {
    const darkMode = isDarkTheme();
    const fontCSS = fonts ? fontFaceCSS(fonts) : '';
    const nonce = crypto.randomBytes(16).toString('base64');
    const fontSources = fonts
      ? `${fonts.spaceGrotesk500} ${fonts.spaceGrotesk700} ${fonts.jetBrainsMono400}`
      : '';
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; font-src ${fontSources}; img-src data:;">
          <title>Dendro: Live Runtime Tree</title>
          <style>
            ${fontCSS}
            *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
            html, body { width: 100%; height: 100%; overflow: hidden; }
            body { font-family: 'Space Grotesk', Inter, 'IBM Plex Sans', system-ui, -apple-system, sans-serif; }
            #root { width: 100%; height: 100%; }
          </style>
      </head>
      <body>
        <div id="root"></div>
        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          window.dendroSessionId = '${sessionId}';
          window.dendroRuntimeMode = true;
          window.dendroInitialTheme = '${darkMode ? 'dark' : 'light'}';
          window.dendroProjectorMode = ${vscode.workspace.getConfiguration('dendro-react').get<boolean>('projectorMode', false)};
          // Report uncaught errors to the extension (-> local telemetry) and show a
          // non-destructive banner. Never touch #root: it is React's container, and
          // wiping it turns the first error into an uncaught removeChild crash that
          // masks the original message (TOUR-BUG-REPORT.md Bug 3).
          const dendroReportError = (kind, msg, stack) => {
            console.error('Dendro webview ' + kind + ':', msg, stack || '');
            try {
              vscode.postMessage({ type: 'webviewError', kind, message: String(msg), stack: stack ? String(stack) : undefined, sessionId: window.dendroSessionId });
            } catch (_) { /* posting must never throw */ }
            let el = document.getElementById('dendro-error-banner');
            if (!el) {
              el = document.createElement('div');
              el.id = 'dendro-error-banner';
              el.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9999;background:rgba(45,0,0,0.95);color:#ff6b6b;padding:8px 12px;font:12px monospace;';
              document.body.appendChild(el);
            }
            el.textContent = 'Dendro error: ' + msg;
          };
          window.onerror = (msg, url, line, col, err) => { dendroReportError('error', msg, err && err.stack); };
          window.onunhandledrejection = (e) => {
            const r = e && e.reason;
            dendroReportError('unhandledrejection', (r && r.message) || String(r), r && r.stack);
          };
        </script>
        <script nonce="${nonce}" src="${uri}"></script>
      </body>
      </html>
    `;
  }
}

function deactivate() {
  clearRuntimeState();
  clearVisualizerStatus();
  clearInspectRequest();
  clearOverrideRequest();
  licenseManagerInstance?.dispose();
  licenseManagerInstance = undefined;
}

exports.activate = activate;
exports.deactivate = deactivate;
