import * as path from 'path';
import * as fs from 'fs';

// ── Workspace Root Initialization ──────────────────────────────────────

let _workspaceRoot: string | null = null;
let _permissiveMode = false;

/**
 * Initialize workspace boundary. Called once at MCP server startup.
 * Priority: DENDRO_WORKSPACE_ROOT env var > process.cwd()
 * Falls back to permissive mode if cwd is "/" or a system directory.
 */
export function initWorkspaceRoot(): void {
  const envRoot = process.env.DENDRO_WORKSPACE_ROOT;
  const candidate = envRoot || process.cwd();
  const resolved = path.resolve(candidate);

  // Reject clearly wrong roots
  const root = path.parse(resolved).root; // "/" on unix, "C:\\" on windows
  const UNSAFE_ROOTS = [root, '/tmp', '/var', '/usr', '/etc', '/bin', '/sbin'];
  if (UNSAFE_ROOTS.includes(resolved)) {
    _workspaceRoot = null;
    _permissiveMode = true;
    console.error(
      `Dendro: workspace root "${resolved}" is too broad. ` +
      `Running in permissive mode (no path boundary enforcement). ` +
      `Set DENDRO_WORKSPACE_ROOT to restrict file access.`
    );
    return;
  }

  _workspaceRoot = resolved;
  _permissiveMode = false;
}

/** Returns the current workspace root, or null if in permissive mode. */
export function getWorkspaceRoot(): string | null {
  return _workspaceRoot;
}

/** Returns true if path boundary enforcement is disabled. */
export function isPermissiveMode(): boolean {
  return _permissiveMode;
}

// ── Path Validation ────────────────────────────────────────────────────

export interface PathValidationResult {
  valid: boolean;
  resolvedPath: string;
  error?: string;
}

/**
 * Validate that a path falls within the workspace root.
 *
 * 1. Resolves relative paths to absolute.
 * 2. Resolves symlinks via fs.realpathSync when the path exists.
 * 3. Checks resolved path starts with workspaceRoot + path.sep (or equals it).
 * 4. In permissive mode, skips boundary check (backward compat).
 */
export function validatePath(
  inputPath: string,
  requireExists = true
): PathValidationResult {
  const absolutePath = path.resolve(inputPath);

  // Permissive mode: only check existence, skip boundary
  if (_permissiveMode) {
    if (requireExists && !fs.existsSync(absolutePath)) {
      return { valid: false, resolvedPath: absolutePath, error: `Path not found: ${absolutePath}` };
    }
    return { valid: true, resolvedPath: absolutePath };
  }

  if (!_workspaceRoot) {
    return {
      valid: false,
      resolvedPath: absolutePath,
      error: 'Workspace root not initialized. Call initWorkspaceRoot() at startup.',
    };
  }

  // Resolve symlinks if path exists on disk
  let realPath: string;
  if (fs.existsSync(absolutePath)) {
    try {
      realPath = fs.realpathSync(absolutePath);
    } catch {
      return { valid: false, resolvedPath: absolutePath, error: `Cannot resolve path: ${absolutePath}` };
    }
  } else if (requireExists) {
    return { valid: false, resolvedPath: absolutePath, error: `Path not found: ${absolutePath}` };
  } else {
    // Path doesn't exist yet (e.g., snapshot dir to be created) — validate absolute form
    realPath = absolutePath;
  }

  // Boundary check
  const workspaceWithSep = _workspaceRoot + path.sep;
  if (realPath !== _workspaceRoot && !realPath.startsWith(workspaceWithSep)) {
    return {
      valid: false,
      resolvedPath: realPath,
      error:
        `Access denied: "${realPath}" is outside the workspace boundary "${_workspaceRoot}". ` +
        `Only paths within the project root are allowed.`,
    };
  }

  return { valid: true, resolvedPath: realPath };
}

/**
 * Validate a path and throw PathBoundaryError if invalid.
 * Returns the resolved (symlink-dereferenced) path on success.
 */
export function assertPathInWorkspace(
  inputPath: string,
  paramName: string,
  requireExists = true
): string {
  const result = validatePath(inputPath, requireExists);
  if (!result.valid) {
    throw new PathBoundaryError(result.error!, paramName, inputPath);
  }
  return result.resolvedPath;
}

/**
 * Custom error for path boundary violations.
 * Caught by existing catch(err) blocks in tool handlers.
 */
export class PathBoundaryError extends Error {
  public readonly paramName: string;
  public readonly inputPath: string;

  constructor(message: string, paramName: string, inputPath: string) {
    super(message);
    this.name = 'PathBoundaryError';
    this.paramName = paramName;
    this.inputPath = inputPath;
  }
}
