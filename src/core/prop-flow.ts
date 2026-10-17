/**
 * Prop Flow Analysis Module
 *
 * Traces how props flow through React component hierarchies.
 * Handles direct props, renames, typed spreads, and common HOC patterns.
 *
 * Graceful degradation for:
 * - Untyped spread props
 * - Custom HOCs
 * - Context boundaries
 * - State management boundaries
 *
 * @module prop-flow
 */

import { Project, SourceFile, SyntaxKind, Node, Type } from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';

/**
 * A node in the prop flow graph
 */
export interface PropFlowNode {
  component: string;
  filePath: string;
  propName: string;
  passedAs?: string;        // If renamed from parent
  spreadResolved: boolean;  // Whether spread props were resolved
  spreadSource?: string;    // Variable name if from spread
  confidence: 'high' | 'medium' | 'low';
  line?: number;
  children: PropFlowNode[];
}

/**
 * A boundary where prop flow tracking stops
 */
export interface FlowBoundary {
  type: 'context' | 'hoc' | 'external' | 'spread_unresolved' | 'dynamic' | 'not_found';
  message: string;
  component?: string;
  filePath?: string;
  details?: Record<string, unknown>;
}

/**
 * Result of prop flow analysis
 */
export interface PropFlowResult {
  sourceProp: string;
  sourceComponent: string;
  sourceFile: string;
  flow: PropFlowNode[];
  boundaries: FlowBoundary[];
  totalComponentsTraced: number;
  error?: string;
}

/**
 * Internal representation of a JSX prop usage
 */
interface PropUsage {
  component: string;
  propName: string;
  valueName?: string;       // The variable/prop being passed
  isSpread: boolean;
  spreadVariable?: string;
  line: number;
  filePath?: string;
}

/**
 * Known HOCs that pass through props
 */
const PASSTHROUGH_HOCS = new Set([
  'memo',
  'forwardRef',
  'React.memo',
  'React.forwardRef',
]);

/**
 * Known HOCs that inject props
 */
const INJECTING_HOCS: Record<string, string[]> = {
  'connect': ['dispatch'], // Redux connect
  'withRouter': ['history', 'location', 'match'], // React Router (legacy)
  'withAuth': ['user', 'isAuthenticated'], // Common auth pattern
};

/**
 * Create a ts-morph Project for analysis
 */
function createProject(rootDir: string): Project {
  const tsConfigPath = path.join(rootDir, 'tsconfig.json');

  if (fs.existsSync(tsConfigPath)) {
    return new Project({
      tsConfigFilePath: tsConfigPath,
      skipAddingFilesFromTsConfig: true,
    });
  }

  return new Project({
    compilerOptions: {
      jsx: 4, // JsxEmit.ReactJSX
      target: 99, // ScriptTarget.ESNext
      module: 99, // ModuleKind.ESNext
      moduleResolution: 2, // ModuleResolutionKind.NodeJs
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      strict: false,
    },
  });
}

/**
 * Get component name from a file
 */
function getComponentName(sourceFile: SourceFile): string | null {
  // Try to find default export
  const defaultExport = sourceFile.getDefaultExportSymbol();
  if (defaultExport) {
    return defaultExport.getName();
  }

  // Try to find a function declaration that looks like a component
  const functions = sourceFile.getFunctions();
  for (const func of functions) {
    const name = func.getName();
    if (name && /^[A-Z]/.test(name)) {
      return name;
    }
  }

  // Try to find an arrow function that looks like a component
  const variables = sourceFile.getVariableDeclarations();
  for (const variable of variables) {
    const name = variable.getName();
    if (name && /^[A-Z]/.test(name)) {
      const init = variable.getInitializer();
      if (init && (
        init.getKind() === SyntaxKind.ArrowFunction ||
        init.getKind() === SyntaxKind.FunctionExpression
      )) {
        return name;
      }
    }
  }

  // Fallback to filename
  const baseName = path.basename(sourceFile.getFilePath(), path.extname(sourceFile.getFilePath()));
  return baseName;
}

/**
 * Get props interface/type for a component
 */
function getPropsType(sourceFile: SourceFile, componentName: string): Type | null {
  // Find the component function
  const func = sourceFile.getFunction(componentName);
  if (func) {
    const params = func.getParameters();
    if (params.length > 0) {
      return params[0].getType();
    }
  }

  // Try arrow function
  const variable = sourceFile.getVariableDeclaration(componentName);
  if (variable) {
    const init = variable.getInitializer();
    if (init && (
      init.getKind() === SyntaxKind.ArrowFunction ||
      init.getKind() === SyntaxKind.FunctionExpression
    )) {
      const func = init.getKind() === SyntaxKind.ArrowFunction
        ? init.asKindOrThrow(SyntaxKind.ArrowFunction)
        : init.asKindOrThrow(SyntaxKind.FunctionExpression);
      const params = func.getParameters();
      if (params.length > 0) {
        return params[0].getType();
      }
    }
  }

  return null;
}

/**
 * Get property names from a type
 */
function getTypeProperties(type: Type): string[] {
  try {
    const properties = type.getProperties();
    return properties.map(p => p.getName());
  } catch {
    return [];
  }
}

/**
 * Public: extract a component's props signature from its TypeScript type.
 * The one piece of a component's contract nothing else exposed — agents had
 * to chain four tools and still never got prop NAMES with type-level truth.
 * Returns null props when the component takes no params or the type is
 * unresolvable (plain JS) — callers should fall back to destructured names.
 */
export function getPropsSignature(filePath: string, componentName: string): { props: string[] | null; typeText: string | null; inheritsFrom?: string[] } {
  try {
    const project = createProject(findProjectRoot(filePath));
    const sourceFile = project.addSourceFileAtPath(filePath);
    const propsType = getPropsType(sourceFile, componentName);
    if (!propsType) return { props: null, typeText: null };

    // Prefer the DECLARED members of the props interface/type over the full
    // resolved property set — `interface Props extends React.HTMLAttributes`
    // resolves to 200+ inherited DOM attributes, which buries the component's
    // actual contract. Inherited bases are reported by name instead.
    const sym = propsType.getAliasSymbol() ?? propsType.getSymbol();
    const declared: string[] = [];
    const inheritsFrom: string[] = [];
    for (const decl of sym?.getDeclarations() ?? []) {
      if (Node.isInterfaceDeclaration(decl)) {
        declared.push(...decl.getProperties().map(p => p.getName()));
        inheritsFrom.push(...decl.getExtends().map(e => e.getText()));
      } else if (Node.isTypeAliasDeclaration(decl)) {
        const tn = decl.getTypeNode();
        if (tn && Node.isTypeLiteral(tn)) {
          declared.push(...tn.getProperties().map(p => p.getName()));
        }
      } else if (Node.isTypeLiteral(decl)) {
        declared.push(...decl.getProperties().map(p => p.getName()));
      }
    }
    if (declared.length > 0) {
      return {
        props: Array.from(new Set(declared)),
        typeText: propsType.getText().slice(0, 300),
        inheritsFrom: inheritsFrom.length > 0 ? inheritsFrom : undefined,
      };
    }

    // No declaration found (inline literal params, imported utility types):
    // fall back to the resolved set, but a huge list means inherited noise —
    // return null so the caller uses destructured names instead.
    const all = getTypeProperties(propsType);
    if (all.length === 0 || all.length > 40) return { props: null, typeText: propsType.getText().slice(0, 300) };
    return { props: all, typeText: propsType.getText().slice(0, 300) };
  } catch {
    return { props: null, typeText: null };
  }
}

/**
 * Find JSX usages in a source file
 */
function findJsxUsages(sourceFile: SourceFile): PropUsage[] {
  const usages: PropUsage[] = [];

  // Find all JSX elements
  sourceFile.forEachDescendant((node) => {
    if (node.getKind() === SyntaxKind.JsxOpeningElement ||
        node.getKind() === SyntaxKind.JsxSelfClosingElement) {

      const tagName = node.getChildAtIndex(1);
      if (!tagName) return;

      const componentName = tagName.getText();

      // Skip HTML elements (lowercase)
      if (/^[a-z]/.test(componentName)) return;

      // Get attributes
      const attributes = node.getChildrenOfKind(SyntaxKind.JsxAttributes)[0];
      if (!attributes) return;

      for (const attr of attributes.getChildren()) {
        if (attr.getKind() === SyntaxKind.JsxAttribute) {
          const nameNode = attr.getChildAtIndex(0);
          const valueNode = attr.getChildAtIndex(2);

          if (nameNode) {
            const propName = nameNode.getText();
            let valueName: string | undefined;

            if (valueNode) {
              // Handle {expression}
              if (valueNode.getKind() === SyntaxKind.JsxExpression) {
                const expr = valueNode.getChildAtIndex(1);
                if (expr) {
                  valueName = expr.getText();
                }
              } else {
                valueName = valueNode.getText();
              }
            }

            usages.push({
              component: componentName,
              propName,
              valueName,
              isSpread: false,
              line: attr.getStartLineNumber(),
            });
          }
        } else if (attr.getKind() === SyntaxKind.JsxSpreadAttribute) {
          // Handle {...props}
          const expr = attr.getChildAtIndex(2);
          const spreadVariable = expr?.getText();

          usages.push({
            component: componentName,
            propName: '*',
            isSpread: true,
            spreadVariable,
            line: attr.getStartLineNumber(),
          });
        }
      }
    }
  });

  return usages;
}

/**
 * Check if a component is wrapped in a known HOC
 */
function detectHOCWrapping(sourceFile: SourceFile, componentName: string): {
  isWrapped: boolean;
  hocName?: string;
  injectedProps?: string[];
} {
  // Check export default statements for HOC wrapping
  const defaultExport = sourceFile.getExportAssignment(a => !a.isExportEquals());

  if (defaultExport) {
    const expr = defaultExport.getExpression();
    const text = expr.getText();

    // Check for HOC patterns like: memo(Component), connect()(Component)
    for (const [hocName, injectedProps] of Object.entries(INJECTING_HOCS)) {
      if (text.includes(hocName)) {
        return { isWrapped: true, hocName, injectedProps };
      }
    }

    for (const hocName of PASSTHROUGH_HOCS) {
      if (text.includes(hocName)) {
        return { isWrapped: true, hocName, injectedProps: [] };
      }
    }
  }

  return { isWrapped: false };
}

/**
 * Resolve an import to a file path
 */
function resolveImport(sourceFile: SourceFile, componentName: string): string | null {
  const imports = sourceFile.getImportDeclarations();

  for (const imp of imports) {
    // Check named imports
    for (const named of imp.getNamedImports()) {
      if (named.getName() === componentName || named.getAliasNode()?.getText() === componentName) {
        const moduleSpecifier = imp.getModuleSpecifierValue();
        const sourceDir = path.dirname(sourceFile.getFilePath());

        // Only resolve local imports
        if (!moduleSpecifier.startsWith('.') && !moduleSpecifier.startsWith('/')) {
          return null;
        }

        // Try to resolve the file
        const extensions = ['.tsx', '.ts', '.jsx', '.js'];
        const basePath = path.resolve(sourceDir, moduleSpecifier);

        for (const ext of extensions) {
          const filePath = basePath + ext;
          if (fs.existsSync(filePath)) {
            return filePath;
          }
        }

        // Try index files
        for (const ext of extensions) {
          const indexPath = path.join(basePath, `index${ext}`);
          if (fs.existsSync(indexPath)) {
            return indexPath;
          }
        }
      }
    }

    // Check default import
    const defaultImport = imp.getDefaultImport();
    if (defaultImport && defaultImport.getText() === componentName) {
      const moduleSpecifier = imp.getModuleSpecifierValue();
      const sourceDir = path.dirname(sourceFile.getFilePath());

      if (!moduleSpecifier.startsWith('.') && !moduleSpecifier.startsWith('/')) {
        return null;
      }

      const extensions = ['.tsx', '.ts', '.jsx', '.js'];
      const basePath = path.resolve(sourceDir, moduleSpecifier);

      for (const ext of extensions) {
        const filePath = basePath + ext;
        if (fs.existsSync(filePath)) {
          return filePath;
        }
      }

      for (const ext of extensions) {
        const indexPath = path.join(basePath, `index${ext}`);
        if (fs.existsSync(indexPath)) {
          return indexPath;
        }
      }
    }
  }

  return null;
}

/**
 * Trace prop flow from a source component
 */
export function tracePropFlow(
  sourceFile: string,
  propName: string,
  options: { maxDepth?: number } = {}
): PropFlowResult {
  const maxDepth = options.maxDepth ?? 10;

  if (!fs.existsSync(sourceFile)) {
    return {
      sourceProp: propName,
      sourceComponent: '',
      sourceFile,
      flow: [],
      boundaries: [{
        type: 'not_found',
        message: `Source file not found: ${sourceFile}`,
      }],
      totalComponentsTraced: 0,
      error: `Source file not found: ${sourceFile}`,
    };
  }

  const rootDir = findProjectRoot(sourceFile);
  const project = createProject(rootDir);

  try {
    project.addSourceFilesAtPaths(sourceFile);
  } catch (error) {
    return {
      sourceProp: propName,
      sourceComponent: '',
      sourceFile,
      flow: [],
      boundaries: [],
      totalComponentsTraced: 0,
      error: `Failed to add source file: ${error}`,
    };
  }

  const source = project.getSourceFile(sourceFile);
  if (!source) {
    return {
      sourceProp: propName,
      sourceComponent: '',
      sourceFile,
      flow: [],
      boundaries: [],
      totalComponentsTraced: 0,
      error: `Failed to parse source file`,
    };
  }

  const componentName = getComponentName(source);
  const boundaries: FlowBoundary[] = [];
  const visited = new Set<string>();
  let totalTraced = 0;

  /**
   * Recursively trace prop flow
   */
  function trace(
    currentFile: SourceFile,
    currentPropName: string,
    currentComponent: string,
    depth: number,
    parentPropName?: string
  ): PropFlowNode[] {
    if (depth > maxDepth) {
      return [];
    }

    const filePath = currentFile.getFilePath();
    const visitKey = `${filePath}:${currentPropName}`;

    if (visited.has(visitKey)) {
      return [];
    }
    visited.add(visitKey);
    totalTraced++;

    // Check for HOC wrapping
    const hocInfo = detectHOCWrapping(currentFile, currentComponent);
    if (hocInfo.isWrapped && hocInfo.injectedProps && hocInfo.injectedProps.length > 0) {
      boundaries.push({
        type: 'hoc',
        message: `HOC ${hocInfo.hocName} may inject additional props: ${hocInfo.injectedProps.join(', ')}`,
        component: currentComponent,
        filePath,
      });
    }

    // Find JSX usages in this file
    const usages = findJsxUsages(currentFile);
    const children: PropFlowNode[] = [];

    for (const usage of usages) {
      // Check if this usage passes the prop we're tracking
      let matchesProp = false;
      let newPropName = currentPropName;
      let isSpread = false;
      let spreadResolved = true;

      if (usage.isSpread) {
        // Check if the spread variable contains our prop
        if (usage.spreadVariable === currentPropName ||
            usage.spreadVariable === 'props' ||
            usage.spreadVariable?.endsWith('Props')) {
          matchesProp = true;
          isSpread = true;

          // Try to resolve spread type
          const propsType = getPropsType(currentFile, currentComponent);
          if (propsType) {
            const props = getTypeProperties(propsType);
            if (!props.includes(currentPropName)) {
              spreadResolved = false;
              boundaries.push({
                type: 'spread_unresolved',
                message: `Spread detected (${usage.spreadVariable}), props may include ${currentPropName}`,
                component: usage.component,
                filePath,
              });
            }
          } else {
            spreadResolved = false;
          }
        }
      } else if (usage.valueName === currentPropName ||
                 usage.valueName === `props.${currentPropName}`) {
        matchesProp = true;
        newPropName = usage.propName;
      }

      if (matchesProp) {
        // Resolve the imported component
        const childFilePath = resolveImport(currentFile, usage.component);

        if (childFilePath) {
          // Add to project if not already there
          let childFile = project.getSourceFile(childFilePath);
          if (!childFile) {
            try {
              childFile = project.addSourceFileAtPath(childFilePath);
            } catch {
              boundaries.push({
                type: 'external',
                message: `Could not parse child component: ${usage.component}`,
                component: usage.component,
                filePath: childFilePath,
              });
              continue;
            }
          }

          const childComponent = getComponentName(childFile) || usage.component;

          // Recursively trace into child
          const childNodes = trace(
            childFile,
            newPropName,
            childComponent,
            depth + 1,
            usage.propName !== currentPropName ? usage.propName : undefined
          );

          children.push({
            component: usage.component,
            filePath: childFilePath,
            propName: newPropName,
            passedAs: parentPropName,
            spreadResolved,
            spreadSource: isSpread ? usage.spreadVariable : undefined,
            confidence: spreadResolved ? 'high' : 'medium',
            line: usage.line,
            children: childNodes,
          });
        } else {
          // External or unresolved component
          boundaries.push({
            type: 'external',
            message: `External or unresolved component: ${usage.component}`,
            component: usage.component,
            filePath,
          });
        }
      }
    }

    return children;
  }

  const flow = trace(source, propName, componentName || '', 0);

  return {
    sourceProp: propName,
    sourceComponent: componentName || path.basename(sourceFile),
    sourceFile,
    flow,
    boundaries,
    totalComponentsTraced: totalTraced,
  };
}

/**
 * Find the project root (directory containing package.json or tsconfig.json)
 */
function findProjectRoot(filePath: string): string {
  let dir = path.dirname(filePath);

  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json')) ||
        fs.existsSync(path.join(dir, 'tsconfig.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  return path.dirname(filePath);
}
