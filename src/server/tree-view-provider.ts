/**
 * Tree View Provider for Dendro Component Tree
 *
 * Provides an always-visible component tree in the VS Code sidebar.
 * Supports two modes:
 *   - Static: parsed from source files, click to navigate
 *   - Runtime: live from connected React Native app, click to inspect
 *
 * @module tree-view-provider
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { buildComponentTree, ComponentNode } from './parser-oxc';
import type { RuntimeTree, RuntimeComponent, InspectedElement } from '../runtime/types';

/**
 * Tree item representing a component in the sidebar tree view.
 */
export class ComponentTreeItem extends vscode.TreeItem {
  /** Extension root path, set once at provider init */
  static extensionPath: string = '';

  constructor(
    public readonly componentName: string,
    public readonly filePath: string,
    public readonly componentType: 'functional' | 'class' | null,
    public readonly stateVars: string[],
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly children: ComponentNode[],
    public readonly memoized: boolean = false
  ) {
    super(componentName, collapsibleState);

    // Set tooltip with component details
    const typeLabel = componentType === 'functional' ? 'Functional' :
                      componentType === 'class' ? 'Class' : 'Unknown';
    const memoLabel = memoized ? ' (memo)' : '';
    const stateInfo = stateVars.length > 0 ? `\nState: ${stateVars.join(', ')}` : '';
    this.tooltip = `${componentName} (${typeLabel}${memoLabel})${stateInfo}\n${filePath}`;

    // Set description (shown after the label in gray)
    this.description = (componentType || '') + (memoized ? ' memo' : '');

    // Set icon — use custom Dendro icons if extension path is available
    if (ComponentTreeItem.extensionPath) {
      const iconName = memoized ? 'component-memo' :
                       componentType === 'class' ? 'component-class' : 'component-functional';
      this.iconPath = {
        light: vscode.Uri.file(path.join(ComponentTreeItem.extensionPath, 'images', 'icons', `${iconName}-light.svg`)),
        dark: vscode.Uri.file(path.join(ComponentTreeItem.extensionPath, 'images', 'icons', `${iconName}-dark.svg`)),
      };
    } else {
      this.iconPath = new vscode.ThemeIcon(
        componentType === 'class' ? 'symbol-class' : 'symbol-method'
      );
    }

    // Set context value for potential context menu actions
    this.contextValue = 'component';

    // Set command to open file on click
    this.command = {
      command: 'dendro-react.openComponent',
      title: 'Open Component',
      arguments: [filePath]
    };
  }
}

/**
 * Verification status for a component node.
 */
export type VerificationStatus = 'verified' | 'failed' | 'inconclusive' | 'untested';

/**
 * Tree item for runtime components (live from connected app).
 */
export class RuntimeTreeItem extends vscode.TreeItem {
  public readonly runtimeId: number;
  public readonly runtimeType: 'function' | 'class' | 'host' | 'other';
  public readonly sourceFilePath: string | null;
  public readonly verificationStatus: VerificationStatus | null;

  constructor(
    componentName: string,
    runtimeId: number,
    componentType: 'function' | 'class' | 'host' | 'other',
    collapsibleState: vscode.TreeItemCollapsibleState,
    sourceFilePath: string | null = null,
    verificationStatus: VerificationStatus | null = null
  ) {
    super(componentName, collapsibleState);

    this.runtimeId = runtimeId;
    this.runtimeType = componentType;
    this.sourceFilePath = sourceFilePath;
    this.verificationStatus = verificationStatus;

    // Tooltip
    const typeLabel = componentType === 'function' ? 'Live Function' :
                      componentType === 'class' ? 'Live Class' :
                      componentType === 'host' ? 'Native' : 'Other';
    const sourceInfo = sourceFilePath ? `\nSource: ${sourceFilePath}` : '';
    const verifyInfo = verificationStatus ? `\nVerification: ${verificationStatus}` : '';
    this.tooltip = `${componentName} (${typeLabel})\nRuntime ID: ${runtimeId}${sourceInfo}${verifyInfo}`;

    // Description — include verification badge
    const verifyBadge = verificationStatus === 'verified' ? ' \u2713' :
                        verificationStatus === 'failed' ? ' \u2717' :
                        verificationStatus === 'inconclusive' ? ' ?' : '';
    this.description = (componentType === 'host' ? 'native' : `live ${componentType}`) + verifyBadge;

    // Icon — color based on verification status if available, otherwise green for live
    const iconColor = verificationStatus === 'verified' ? 'charts.green' :
                      verificationStatus === 'failed' ? 'errorForeground' :
                      verificationStatus === 'inconclusive' ? 'editorWarning.foreground' :
                      'charts.green';
    this.iconPath = new vscode.ThemeIcon(
      componentType === 'host' ? 'symbol-property' :
      componentType === 'class' ? 'symbol-class' : 'symbol-method',
      new vscode.ThemeColor(iconColor)
    );

    // Context value for context menu
    this.contextValue = 'runtimeComponent';

    // Click action: open source file if known, otherwise inspect
    if (sourceFilePath && fs.existsSync(sourceFilePath)) {
      this.command = {
        command: 'dendro-react.openComponent',
        title: 'Open Source File',
        arguments: [sourceFilePath]
      };
    } else {
      this.command = {
        command: 'dendro-react.inspectRuntimeComponent',
        title: 'Inspect Component',
        arguments: [runtimeId]
      };
    }
  }
}

/**
 * Tree item for inspection data categories (Props, State, Hooks, Context).
 */
export class InspectionCategoryItem extends vscode.TreeItem {
  public readonly category: 'props' | 'state' | 'hooks' | 'context';
  public readonly entries: [string, unknown][];

  constructor(
    category: 'props' | 'state' | 'hooks' | 'context',
    entries: [string, unknown][]
  ) {
    const icons: Record<string, string> = {
      props: 'symbol-field',
      state: 'symbol-variable',
      hooks: 'symbol-event',
      context: 'symbol-namespace',
    };
    const labels: Record<string, string> = {
      props: 'Props',
      state: 'State',
      hooks: 'Hooks',
      context: 'Context',
    };

    const label = `${labels[category]} (${entries.length})`;
    const hasChildren = entries.length > 0;

    super(label, hasChildren
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None);

    this.category = category;
    this.entries = entries;
    this.iconPath = new vscode.ThemeIcon(icons[category], new vscode.ThemeColor('charts.yellow'));
    this.contextValue = 'inspectionCategory';
  }
}

/**
 * Tree item for individual inspection properties (leaf node).
 */
export class InspectionPropertyItem extends vscode.TreeItem {
  constructor(key: string, value: unknown) {
    const formatted = formatValue(value);
    super(`${key}: ${formatted}`, vscode.TreeItemCollapsibleState.None);

    this.tooltip = `${key}: ${JSON.stringify(value, null, 2)}`;
    this.iconPath = new vscode.ThemeIcon('symbol-constant');
    this.contextValue = 'inspectionProperty';
  }
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value.length > 40 ? `"${value.slice(0, 37)}..."` : `"${value}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'function') return '[Function]';
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === 'object') return `{${Object.keys(value).length} keys}`;
  return String(value);
}

/**
 * Extended ComponentNode with full file path for navigation.
 */
interface ComponentNodeWithPath extends ComponentNode {
  fullPath: string;
  children: ComponentNodeWithPath[];
}

/**
 * Tree Data Provider for the component tree sidebar.
 * Uses vscode.TreeItem as the generic type to support multiple item types.
 */
export class ComponentTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> =
    new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private rootFilePath: string | null = null;
  private treeData: ComponentNodeWithPath | null = null;
  private runtimeTree: RuntimeTree | null = null;
  private isRuntimeMode: boolean = false;
  private inspectedElements: Map<number, InspectedElement> = new Map();
  private sourceMap: Map<string, string> = new Map(); // displayName → filePath
  private verificationMap: Map<string, VerificationStatus> = new Map(); // displayName → status
  private disposables: vscode.Disposable[] = [];

  constructor() {
    // Listen for file saves to auto-refresh
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.rootFilePath && /\.(tsx|jsx|ts|js)$/.test(doc.fileName)) {
          this.refresh();
        }
      })
    );

    // Listen for file creates/deletes
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{tsx,jsx,ts,js}');
    this.disposables.push(watcher);
    this.disposables.push(watcher.onDidCreate(() => this.refresh()));
    this.disposables.push(watcher.onDidDelete(() => this.refresh()));
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this._onDidChangeTreeData.dispose();
  }

  /**
   * Set the root file for the component tree.
   */
  setRootFile(filePath: string): void {
    this.rootFilePath = filePath;
    this.rebuildTree();
    this._onDidChangeTreeData.fire();
  }

  /**
   * Clear the tree (show empty state).
   */
  clear(): void {
    this.rootFilePath = null;
    this.treeData = null;
    this.runtimeTree = null;
    this.isRuntimeMode = false;
    this.inspectedElements.clear();
    this._onDidChangeTreeData.fire();
  }

  /**
   * Set runtime tree data from live app connection.
   */
  setRuntimeTree(tree: RuntimeTree): void {
    console.log(`Dendro TreeProvider: setRuntimeTree called - roots: ${tree.roots.length}, elements: ${tree.elements.size}`);
    this.runtimeTree = tree;
    this.isRuntimeMode = true;
    this._onDidChangeTreeData.fire();
  }

  /**
   * Update source map for runtime components.
   */
  setSourceMap(sourceMap: Map<string, string>): void {
    this.sourceMap = sourceMap;
    if (this.isRuntimeMode) {
      this._onDidChangeTreeData.fire();
    }
  }

  /**
   * Store inspection result and refresh the inspected item.
   */
  setInspectionResult(element: InspectedElement): void {
    this.inspectedElements.set(element.id, element);
    this._onDidChangeTreeData.fire();
  }

  /**
   * Set verification status for components (by displayName).
   * Used by Triggered Projection + Verified Projection pipeline.
   */
  setVerificationResults(results: Map<string, VerificationStatus>): void {
    this.verificationMap = results;
    this._onDidChangeTreeData.fire();
  }

  /**
   * Clear verification badges.
   */
  clearVerificationResults(): void {
    this.verificationMap.clear();
    this._onDidChangeTreeData.fire();
  }

  /**
   * Clear runtime mode and return to static analysis.
   */
  clearRuntimeTree(): void {
    this.runtimeTree = null;
    this.isRuntimeMode = false;
    this.inspectedElements.clear();
    this.sourceMap.clear();
    this.verificationMap.clear();
    this._onDidChangeTreeData.fire();
  }

  /**
   * Refresh the tree data.
   */
  refresh(): void {
    if (this.rootFilePath) {
      this.rebuildTree();
    }
    this._onDidChangeTreeData.fire();
  }

  /**
   * Rebuild the internal tree data from the root file.
   */
  private rebuildTree(): void {
    if (!this.rootFilePath || !fs.existsSync(this.rootFilePath)) {
      this.treeData = null;
      return;
    }

    const baseDir = path.dirname(this.rootFilePath);
    const tree = buildComponentTree(this.rootFilePath, baseDir);

    if (tree) {
      this.treeData = this.addFullPaths(tree, baseDir, this.rootFilePath);
    } else {
      this.treeData = null;
    }
  }

  /**
   * Add full file paths to all nodes for navigation.
   */
  private addFullPaths(
    node: ComponentNode,
    baseDir: string,
    currentPath: string
  ): ComponentNodeWithPath {
    const children: ComponentNodeWithPath[] = [];

    for (const child of node.children) {
      const childPath = this.findComponentFile(child.file, baseDir);
      if (childPath) {
        children.push(this.addFullPaths(child, path.dirname(childPath), childPath));
      }
    }

    return {
      ...node,
      fullPath: currentPath,
      children
    };
  }

  /**
   * Find a component file by basename, searching common locations.
   */
  private findComponentFile(basename: string, baseDir: string): string | null {
    const extensions = ['.tsx', '.jsx', '.ts', '.js'];
    const baseName = basename.replace(/\.(tsx|jsx|ts|js)$/, '');

    // Try direct path
    for (const ext of extensions) {
      const directPath = path.join(baseDir, `${baseName}${ext}`);
      if (fs.existsSync(directPath)) {
        return directPath;
      }
    }

    // Try in subdirectories (components/, etc.)
    const searchDirs = [baseDir, path.join(baseDir, 'components'), path.join(baseDir, 'src')];
    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      for (const ext of extensions) {
        const filePath = path.join(dir, `${baseName}${ext}`);
        if (fs.existsSync(filePath)) {
          return filePath;
        }
      }
    }

    return null;
  }

  /**
   * Get tree item for display.
   */
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children of a tree item.
   */
  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    // Runtime mode
    if (this.isRuntimeMode && this.runtimeTree) {
      return this.getRuntimeChildren(element);
    }

    // Static mode
    if (!this.treeData) {
      return Promise.resolve([]);
    }

    if (!element) {
      const root = this.treeData;
      const collapsibleState = root.children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None;

      return Promise.resolve([
        new ComponentTreeItem(
          root.file,
          root.fullPath,
          root.type,
          root.state,
          collapsibleState,
          root.children,
          root.memoized || false
        )
      ]);
    }

    // Static children
    if (element instanceof ComponentTreeItem) {
      const items: vscode.TreeItem[] = element.children.map(child => {
        const childWithPath = child as ComponentNodeWithPath;
        const collapsibleState = childWithPath.children.length > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None;

        return new ComponentTreeItem(
          childWithPath.file,
          childWithPath.fullPath,
          childWithPath.type,
          childWithPath.state,
          collapsibleState,
          childWithPath.children,
          (childWithPath as any).memoized || false
        );
      });
      return Promise.resolve(items);
    }

    return Promise.resolve([]);
  }

  /**
   * Get children for runtime tree mode.
   */
  private getRuntimeChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (!this.runtimeTree) {
      return Promise.resolve([]);
    }

    // Root level — return root components
    if (!element) {
      const roots = this.runtimeTree.roots
        .map(id => this.runtimeTree!.elements.get(id))
        .filter((c): c is RuntimeComponent => c !== undefined);

      return Promise.resolve(
        roots.map(root => this.runtimeComponentToTreeItem(root))
      );
    }

    // Inspection category — return property items
    if (element instanceof InspectionCategoryItem) {
      const items = element.entries.map(([key, value]) =>
        new InspectionPropertyItem(key, value)
      );
      return Promise.resolve(items);
    }

    // Runtime component — return inspection data + child components
    if (element instanceof RuntimeTreeItem) {
      const runtimeId = element.runtimeId;
      const component = this.runtimeTree.elements.get(runtimeId);
      if (!component) return Promise.resolve([]);

      const items: vscode.TreeItem[] = [];

      // Add inspection data if available
      const inspected = this.inspectedElements.get(runtimeId);
      if (inspected) {
        // Props
        if (inspected.props && Object.keys(inspected.props).length > 0) {
          items.push(new InspectionCategoryItem('props', Object.entries(inspected.props)));
        }
        // State
        if (inspected.state && Object.keys(inspected.state).length > 0) {
          items.push(new InspectionCategoryItem('state', Object.entries(inspected.state)));
        }
        // Hooks
        if (inspected.hooks && inspected.hooks.length > 0) {
          const hookEntries: [string, unknown][] = inspected.hooks.map(h => [h.name, h.value]);
          items.push(new InspectionCategoryItem('hooks', hookEntries));
        }
        // Context
        if (inspected.context && Object.keys(inspected.context).length > 0) {
          items.push(new InspectionCategoryItem('context', Object.entries(inspected.context)));
        }
      }

      // Add child components
      const children = component.children
        .map(id => this.runtimeTree!.elements.get(id))
        .filter((c): c is RuntimeComponent => c !== undefined);

      items.push(...children.map(child => this.runtimeComponentToTreeItem(child)));

      return Promise.resolve(items);
    }

    return Promise.resolve([]);
  }

  /**
   * Convert a RuntimeComponent to a tree item with source mapping.
   */
  private runtimeComponentToTreeItem(component: RuntimeComponent): RuntimeTreeItem {
    const hasChildren = component.children.length > 0;
    const isInspected = this.inspectedElements.has(component.id);
    const hasExpandableContent = hasChildren || isInspected;

    const collapsibleState = hasExpandableContent
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;

    const sourceFilePath = this.sourceMap.get(component.displayName) || null;
    const verificationStatus = this.verificationMap.get(component.displayName) || null;

    return new RuntimeTreeItem(
      component.displayName,
      component.id,
      component.type,
      collapsibleState,
      sourceFilePath,
      verificationStatus
    );
  }

  /**
   * Get the current root file path.
   */
  getRootFilePath(): string | null {
    return this.rootFilePath;
  }
}
