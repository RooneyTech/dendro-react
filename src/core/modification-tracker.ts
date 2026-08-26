/**
 * Modification Tracker — Detects which React components have been modified
 *
 * Uses git to find changed component files (.tsx/.jsx/.ts/.js), then extracts
 * the components declared in each file with OXC. Adapted from dendro-swiftui's
 * modification-tracker (git plumbing ported ~verbatim); the resolution step
 * differs by design: dendro-react has no symbol index, so we return modified
 * FILES plus the components each file declares (one file can export several).
 *
 * WHY absolute-path matching only: the swiftui tracker also matched on file
 * basename as a fallback. In React codebases that's a bug magnet — dozens of
 * files are named `index.tsx` — so a changed file is identified strictly by
 * `path.join(gitRoot, <git-relative-path>)` and parsed directly.
 *
 * WHY execFileSync (argv array, no shell): refs and paths come from callers
 * (MCP tool params). Passing them as argv elements means there is no shell to
 * inject into; isSafeGitRef additionally rejects option-lookalikes and `..`
 * before a ref ever reaches git.
 *
 * Honest failure modes (per .dev/REBOOT-PLAN-2026-08.md): a non-repo returns
 * `error: not_a_git_repo`, an invalid/unsafe ref returns `error: bad_ref`
 * (never a silent fallback to HEAD), a clean tree returns an explanatory
 * `note`, and changed files with no detectable components still appear in
 * `files` with an empty `components` array — never silently dropped.
 *
 * @module modification-tracker
 */

import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { parseSync } from 'oxc-parser';
import { walkAST, type ESTreeNode } from './utils/ast-walker';

/** File extensions the tracker considers component-bearing. */
export const TRACKED_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js'];

export type ModifiedFileStatus = 'modified' | 'added' | 'untracked' | 'staged';

export interface ModifiedComponent {
  name: string;
  kind: 'functional' | 'class';
}

export interface ModifiedFile {
  /** Path relative to the git root, as git reports it. */
  file: string;
  /** Absolute path (gitRoot + file) — the only identity used for matching. */
  absolutePath: string;
  status: ModifiedFileStatus;
  /** Components declared in this file. Empty array = changed file, no components. */
  components: ModifiedComponent[];
}

export interface ModifiedComponentsResult {
  /** The ref actually compared against (default 'HEAD'). */
  base: string;
  gitRoot: string | null;
  files: ModifiedFile[];
  totalFiles: number;
  totalComponents: number;
  /** Honest-empty explanation (e.g. working tree clean vs <base>). */
  note?: string;
  /** not_a_git_repo | bad_ref, with explanation. */
  error?: string;
}

/**
 * Get the git root directory for a given path. Returns null when the path is
 * not inside a git repository (or git is unavailable).
 */
function getGitRoot(filePath: string): string | null {
  try {
    // `filePath` may be a directory (e.g. the workspace root) or a file. Using
    // dirname() on a directory escapes it — and if that directory IS the repo
    // root, git then runs from the parent and reports "not a git repository".
    // Use the path directly when it's a directory; only dirname() a file.
    const dir = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
      ? filePath
      : path.dirname(filePath);
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'], // expected to fail outside a repo — keep stderr quiet
    }).trim();
    return root;
  } catch {
    return null;
  }
}

/**
 * Validate a git ref/branch passed from a caller before handing it to git.
 * Allows the characters that appear in real branch names, tags, and SHAs
 * (`main`, `origin/main`, `release/1.2`, `a1b2c3d`); rejects anything else
 * (plus `..` and a leading `-`, which git would parse as an option) so an
 * arbitrary string can't be smuggled into a git invocation.
 */
export function isSafeGitRef(ref: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(ref)
    && !ref.includes('..')
    && !ref.startsWith('-')
    && ref.length <= 200;
}

interface DiffEntry {
  file: string;
  status: ModifiedFileStatus;
}

/** Run git with argv (no shell) inside the repo and return trimmed stdout. */
function git(gitRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: gitRoot,
    encoding: 'utf-8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'ignore'], // failures surface as thrown errors, not console noise
  }).trim();
}

/** Parse `git diff --name-status` output into tracked-extension entries. */
function parseNameStatus(
  output: string,
  statusOf: (statusChar: string) => ModifiedFileStatus,
): DiffEntry[] {
  const entries: DiffEntry[] = [];
  if (!output) return entries;
  for (const line of output.split('\n')) {
    const [statusChar, ...fileParts] = line.split('\t');
    // Renames/copies (R100, C75) list "old\tnew" — the new path is last.
    const file = fileParts[fileParts.length - 1] ?? '';
    if (!TRACKED_EXTENSIONS.includes(path.extname(file))) continue;
    // Deleted files no longer exist — there is nothing to parse and the
    // result's status enum deliberately has no 'deleted'.
    if (statusChar.startsWith('D')) continue;
    entries.push({ file, status: statusOf(statusChar) });
  }
  return entries;
}

/**
 * Get modified component files from git. Returns paths relative to git root.
 *
 * - `base === 'HEAD'` (default): the "what have I changed right now" view —
 *   staged changes (`git diff --cached`, status 'staged'/'added'), unstaged
 *   working-tree changes (`git diff HEAD`, status 'modified'/'added'), and
 *   untracked files (`git ls-files --others --exclude-standard`, 'untracked').
 * - any other ref (e.g. `main`, a SHA): committed changes since the branch
 *   diverged from `base` (`git diff <base>...HEAD`) — the "what does this
 *   PR/branch change" view. Staged/untracked working-tree state is excluded.
 *
 * The caller validates `base` (isSafeGitRef + rev-parse) before this runs.
 * Throws on git failure so bad refs surface instead of reading as "no changes".
 */
function getGitDiffFiles(gitRoot: string, base: string): DiffEntry[] {
  // Keyed by git-relative path so a file staged AND further edited appears once.
  const byFile = new Map<string, DiffEntry>();
  const add = (entries: DiffEntry[]) => {
    for (const e of entries) {
      if (!byFile.has(e.file)) byFile.set(e.file, e);
    }
  };

  if (base === 'HEAD') {
    // Everything that differs between working tree and HEAD (staged included).
    add(parseNameStatus(
      git(gitRoot, ['diff', '--name-status', 'HEAD']),
      (c) => (c.startsWith('A') ? 'added' : 'modified'),
    ));
    // Re-tag staged-only files as 'staged': in the index (`--cached`) but with
    // no further unstaged edit on top. A file staged and then edited again
    // stays 'modified' — the working tree is ahead of the index.
    const cached = parseNameStatus(
      git(gitRoot, ['diff', '--name-status', '--cached']),
      (c) => (c.startsWith('A') ? 'added' : 'staged'),
    );
    const unstaged = new Set(
      parseNameStatus(git(gitRoot, ['diff', '--name-status']), () => 'modified').map(e => e.file),
    );
    for (const e of cached) {
      if (!unstaged.has(e.file)) byFile.set(e.file, e);
    }
    const untracked = git(gitRoot, ['ls-files', '--others', '--exclude-standard']);
    if (untracked) {
      for (const file of untracked.split('\n')) {
        if (TRACKED_EXTENSIONS.includes(path.extname(file)) && !byFile.has(file)) {
          byFile.set(file, { file, status: 'untracked' });
        }
      }
    }
  } else {
    add(parseNameStatus(
      git(gitRoot, ['diff', '--name-status', `${base}...HEAD`]),
      (c) => (c.startsWith('A') ? 'added' : 'modified'),
    ));
  }

  return [...byFile.values()];
}

/**
 * Extract the component declarations in one file with OXC.
 *
 * Mirrors complexity-parser's findComponentBoundaries heuristic: a
 * capitalized FunctionDeclaration, a capitalized variable initialized with an
 * arrow/function expression, or a capitalized ClassDeclaration. Nested
 * declarations (a helper component defined inside another) are dropped so
 * inner render helpers don't double-report.
 */
function extractComponents(absolutePath: string): ModifiedComponent[] {
  if (!fs.existsSync(absolutePath)) return [];
  let content: string;
  try {
    content = fs.readFileSync(absolutePath, 'utf-8');
  } catch {
    return [];
  }

  try {
    const parseResult = parseSync(path.basename(absolutePath), content);
    const found: Array<ModifiedComponent & { start: number; end: number }> = [];

    walkAST(parseResult.program, (node: ESTreeNode) => {
      const n = node as { start?: number; end?: number };
      if (typeof n.start !== 'number' || typeof n.end !== 'number') return;

      if (node.type === 'FunctionDeclaration') {
        const id = (node as { id?: { name?: string } }).id;
        if (id?.name && /^[A-Z]/.test(id.name)) {
          found.push({ name: id.name, kind: 'functional', start: n.start, end: n.end });
        }
      }
      if (node.type === 'VariableDeclarator') {
        const id = (node as { id?: { name?: string } }).id;
        const init = (node as { init?: ESTreeNode & { start?: number; end?: number } }).init;
        if (id?.name && /^[A-Z]/.test(id.name) &&
            (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression') &&
            typeof init.start === 'number' && typeof init.end === 'number') {
          found.push({ name: id.name, kind: 'functional', start: init.start, end: init.end });
        }
      }
      if (node.type === 'ClassDeclaration') {
        const id = (node as { id?: { name?: string } }).id;
        if (id?.name && /^[A-Z]/.test(id.name)) {
          found.push({ name: id.name, kind: 'class', start: n.start, end: n.end });
        }
      }
    });

    return found
      .filter(b => !found.some(other => other !== b && other.start < b.start && other.end > b.end))
      .map(({ name, kind }) => ({ name, kind }));
  } catch {
    return [];
  }
}

/**
 * Get all modified React components in a workspace.
 *
 * Runs git to find changed component files, then parses each changed file to
 * list the components it declares. Files are matched by absolute path only.
 *
 * @param workspaceRoot Directory (or file) inside the repository to analyze.
 * @param base Git ref to diff against. Default `'HEAD'` = working-tree changes
 *   (staged + unstaged + untracked). Pass a branch/SHA (e.g. `'main'`) for a
 *   PR-scoped diff (`git diff <base>...HEAD`).
 */
export function getModifiedComponents(
  workspaceRoot: string,
  base: string = 'HEAD',
): ModifiedComponentsResult {
  const empty = (gitRoot: string | null): ModifiedComponentsResult => ({
    base, gitRoot, files: [], totalFiles: 0, totalComponents: 0,
  });

  const gitRoot = getGitRoot(workspaceRoot);
  if (!gitRoot) {
    return {
      ...empty(null),
      error: `not_a_git_repo: ${workspaceRoot} is not inside a git repository (or git is unavailable)`,
    };
  }

  if (base !== 'HEAD') {
    if (!isSafeGitRef(base)) {
      return {
        ...empty(gitRoot),
        error: `bad_ref: '${base}' contains characters not allowed in a git ref`,
      };
    }
    try {
      git(gitRoot, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
    } catch {
      return {
        ...empty(gitRoot),
        error: `bad_ref: '${base}' is not a known ref in this repository`,
      };
    }
  }

  let diffFiles: DiffEntry[];
  try {
    diffFiles = getGitDiffFiles(gitRoot, base);
  } catch (err) {
    return {
      ...empty(gitRoot),
      error: `bad_ref: git diff against '${base}' failed (${err instanceof Error ? err.message.split('\n')[0] : 'unknown error'})`,
    };
  }

  if (diffFiles.length === 0) {
    return {
      ...empty(gitRoot),
      note: base === 'HEAD'
        ? 'working tree clean vs HEAD — no staged, unstaged, or untracked component files'
        : `no changes vs ${base} — no component files differ between ${base} and HEAD`,
    };
  }

  const files: ModifiedFile[] = diffFiles.map(({ file, status }) => {
    const absolutePath = path.join(gitRoot, file);
    return { file, absolutePath, status, components: extractComponents(absolutePath) };
  });

  const totalComponents = files.reduce((sum, f) => sum + f.components.length, 0);

  const result: ModifiedComponentsResult = {
    base, gitRoot, files, totalFiles: files.length, totalComponents,
  };
  if (totalComponents === 0) {
    result.note = `${files.length} changed file(s), but none declare a detectable React component — files are listed with empty components`;
  }
  return result;
}

/**
 * Check if a specific file is modified in git (staged, unstaged, or untracked).
 */
export function isFileModified(filePath: string): boolean {
  // Realpath first: on macOS /tmp and /var are symlinks into /private, and git
  // reports realpaths — path.relative on the unresolved path silently escapes
  // the repo and matches nothing.
  let resolved = filePath;
  try {
    resolved = fs.realpathSync(filePath);
  } catch { /* keep as-is for nonexistent paths */ }

  const gitRoot = getGitRoot(resolved);
  if (!gitRoot) return false;

  try {
    const relativePath = path.relative(gitRoot, resolved);
    const output = git(gitRoot, ['status', '--porcelain', '--', relativePath]);
    return output.length > 0;
  } catch {
    return false;
  }
}

/**
 * Build a set of modified files' ABSOLUTE paths for quick lookup (working-tree
 * view, base = HEAD). Absolute paths, not basenames — `index.tsx` collisions
 * made basename sets unreliable.
 */
export function getModifiedFileSet(rootPath: string): Set<string> {
  const gitRoot = getGitRoot(rootPath);
  if (!gitRoot) return new Set();

  try {
    const diffFiles = getGitDiffFiles(gitRoot, 'HEAD');
    return new Set(diffFiles.map(({ file }) => path.join(gitRoot, file)));
  } catch {
    return new Set();
  }
}
