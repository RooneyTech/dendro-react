/**
 * CodeLens Provider for React Component Usage
 *
 * Shows "Used by X components" above React component definitions.
 * Clicking reveals a list of files that import the component.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { findComponentUsages } from './usage-finder';

// Regex patterns to find React component definitions
const COMPONENT_PATTERNS = [
  // function ComponentName(
  /^(?:export\s+)?(?:default\s+)?function\s+([A-Z][a-zA-Z0-9]*)\s*\(/gm,
  // const ComponentName = ( or const ComponentName: React.FC =
  /^(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*(?::\s*[^=]+)?\s*=\s*(?:\([^)]*\)\s*=>|function|\()/gm,
  // const ComponentName = React.memo( or forwardRef(
  /^(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:React\.)?(?:memo|forwardRef)\s*\(/gm,
  // class ComponentName extends Component
  /^(?:export\s+)?class\s+([A-Z][a-zA-Z0-9]*)\s+extends\s+(?:React\.)?(?:Component|PureComponent)/gm
];

interface ComponentLocation {
  name: string;
  line: number;
  range: vscode.Range;
}

export class ComponentUsageCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

  // Cache for usage results to avoid repeated parsing
  private usageCache: Map<string, { count: number; files: string[]; timestamp: number }> = new Map();
  private cacheTTL = 30000; // 30 seconds

  constructor() {
    // Refresh CodeLenses when files are saved
    vscode.workspace.onDidSaveTextDocument(() => {
      this.invalidateCache();
      this._onDidChangeCodeLenses.fire();
    });

    // Refresh when files are created or deleted
    vscode.workspace.onDidCreateFiles(() => {
      this.invalidateCache();
      this._onDidChangeCodeLenses.fire();
    });

    vscode.workspace.onDidDeleteFiles(() => {
      this.invalidateCache();
      this._onDidChangeCodeLenses.fire();
    });
  }

  private invalidateCache(): void {
    this.usageCache.clear();
  }

  /**
   * Find all React component definitions in the document
   */
  private findComponentDefinitions(document: vscode.TextDocument): ComponentLocation[] {
    const components: ComponentLocation[] = [];
    const text = document.getText();
    const seenLines = new Set<number>();

    for (let i = 0; i < COMPONENT_PATTERNS.length; i++) {
      const pattern = COMPONENT_PATTERNS[i];
      // Reset regex state
      pattern.lastIndex = 0;
      let match;

      while ((match = pattern.exec(text)) !== null) {
        const componentName = match[1];
        const position = document.positionAt(match.index);
        const line = position.line;

        // Avoid duplicates on the same line
        if (seenLines.has(line)) continue;
        seenLines.add(line);

        const lineRange = document.lineAt(line).range;
        components.push({
          name: componentName,
          line,
          range: lineRange
        });
      }
    }

    return components;
  }

  /**
   * Get cached or fresh usage data for a component
   */
  private getUsageData(filePath: string): { count: number; files: string[] } {
    const cached = this.usageCache.get(filePath);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return { count: cached.count, files: cached.files };
    }

    try {
      // Find workspace root for search scope
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
      const searchDir = workspaceFolder?.uri.fsPath || path.dirname(filePath);

      const usages = findComponentUsages(filePath, searchDir);
      const files = usages.map(u => u.absolutePath);
      const count = files.length;

      // Cache the result
      this.usageCache.set(filePath, {
        count,
        files,
        timestamp: Date.now()
      });

      return { count, files };
    } catch (error) {
      console.error('[Dendro CodeLens] Error getting usage data:', error);
      return { count: 0, files: [] };
    }
  }

  /**
   * Provide CodeLens items for the document
   */
  public provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
    // Only process React files
    if (!/\.(tsx|jsx)$/.test(document.fileName)) {
      return [];
    }

    const codeLenses: vscode.CodeLens[] = [];
    const components = this.findComponentDefinitions(document);

    for (const component of components) {
      if (token.isCancellationRequested) {
        return [];
      }

      const codeLens = new vscode.CodeLens(component.range);
      // Store metadata for resolveCodeLens
      (codeLens as any).componentName = component.name;
      (codeLens as any).filePath = document.uri.fsPath;

      codeLenses.push(codeLens);
    }

    return codeLenses;
  }

  /**
   * Resolve CodeLens - add the command with usage count
   */
  public resolveCodeLens(
    codeLens: vscode.CodeLens,
    token: vscode.CancellationToken
  ): vscode.CodeLens | Thenable<vscode.CodeLens> {
    if (token.isCancellationRequested) {
      return codeLens;
    }

    try {
      const componentName = (codeLens as any).componentName;
      const filePath = (codeLens as any).filePath;

      const { count, files } = this.getUsageData(filePath);

      let title: string;
      let tooltip: string;

      if (count === 0) {
        title = `$(circle-slash) No usages found`;
        tooltip = `${componentName} is not imported by any other components`;
      } else if (count === 1) {
        title = `$(references) Used by 1 component`;
        tooltip = `Click to see where ${componentName} is used`;
      } else {
        title = `$(references) Used by ${count} components`;
        tooltip = `Click to see all ${count} components that use ${componentName}`;
      }

      codeLens.command = {
        title,
        tooltip,
        command: count > 0 ? 'dendro-react.showComponentUsage' : '',
        arguments: [componentName, files, filePath]
      };

      return codeLens;
    } catch (error) {
      console.error('[Dendro CodeLens] Error in resolveCodeLens:', error);
      return codeLens;
    }
  }

  public dispose(): void {
    this.usageCache.clear();
    this._onDidChangeCodeLenses.dispose();
  }
}
