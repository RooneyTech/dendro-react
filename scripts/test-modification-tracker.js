#!/usr/bin/env node
/**
 * test-modification-tracker.js
 *
 * Tests for src/core/modification-tracker.ts (git modification tracking):
 * - Honest failure modes: not_a_git_repo, bad_ref (unsafe + unknown)
 * - Unsafe ref rejection (no shell injection — sentinel must not appear)
 * - Untracked new component file detection
 * - Modified file detection vs HEAD (unstaged + staged statuses)
 * - Multi-component files list every component (functional + class kinds)
 * - Absolute-path matching (two index.tsx files must not cross-match)
 * - Changed files with no components still listed (empty components array)
 * - PR-scoped diff (base='main')
 * - Honest-empty note on a clean tree
 * - isFileModified / getModifiedFileSet helpers
 *
 * Self-creating git fixtures in a temp dir (os.tmpdir) — nothing touches the
 * repo. Runs against the compiled output:
 *
 * Usage:
 *   npm run compile && node scripts/test-modification-tracker.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const sections = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function section(name, fn) {
  console.log(`\n--- ${name} ---`);
  const before = passed + failed;
  fn();
  sections.push({ name, tests: (passed + failed) - before });
}

// ─── Load module from build output ──────────────────────────────────

const {
  getModifiedComponents,
  isFileModified,
  getModifiedFileSet,
  isSafeGitRef,
  TRACKED_EXTENSIONS,
} = require(path.join(ROOT, 'out/core/modification-tracker'));

// ─── Fixture: throwaway git repo ────────────────────────────────────

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}

function write(repo, rel, content) {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

const HEADER = `import React from 'react';\n`;
const APP = HEADER + `export function App() { return <div>app</div>; }\n`;
const MULTI = HEADER +
  `export function Header() { return <h1>hi</h1>; }\n` +
  `export const Footer = () => <footer>bye</footer>;\n` +
  `export class ErrorBoundary extends React.Component { render() { return this.props.children; } }\n`;
const WIDGET_INDEX = HEADER + `export const Widget = () => <span>w</span>;\n`;
const PANEL_INDEX = HEADER + `export const Panel = () => <span>p</span>;\n`;
const UTILS = `export function formatDate(d) { return String(d); }\n`;

// Scratchpad-friendly temp base: honor CLAUDE scratchpad if present, else os.tmpdir.
const TMP_BASE = process.env.DENDRO_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_BASE, { recursive: true });

const repo = fs.mkdtempSync(path.join(TMP_BASE, 'dendro-modtrack-'));
const nonGitDir = fs.mkdtempSync(path.join(TMP_BASE, 'dendro-nongit-'));

// macOS: /tmp and /var are symlinks (/private/...). git rev-parse returns the
// real path, so resolve fixtures the same way before comparing absolute paths.
const realRepo = fs.realpathSync(repo);

git(repo, ['init', '-b', 'main']);
git(repo, ['config', 'user.email', 'test@example.com']);
git(repo, ['config', 'user.name', 'Test']);

// Base commit on main.
write(repo, 'src/App.tsx', APP);
write(repo, 'src/Multi.tsx', MULTI);
write(repo, 'src/widget/index.tsx', WIDGET_INDEX);
write(repo, 'src/panel/index.tsx', PANEL_INDEX);
write(repo, 'src/utils.ts', UTILS);
git(repo, ['add', '-A']);
git(repo, ['commit', '-q', '-m', 'base']);

console.log('=== Modification Tracker Tests ===');

// ─── Failure modes ──────────────────────────────────────────────────

section('Honest failure modes', () => {
  test('non-git directory returns not_a_git_repo error', () => {
    const result = getModifiedComponents(nonGitDir);
    assert(result.error && result.error.startsWith('not_a_git_repo'),
      `Expected not_a_git_repo error, got: ${result.error}`);
    assert(result.gitRoot === null, 'gitRoot should be null');
    assert(result.files.length === 0 && result.totalFiles === 0, 'no files on error');
  });

  test('unsafe ref is rejected with bad_ref (never falls back to HEAD)', () => {
    const sentinel = path.join(repo, 'PWNED');
    const result = getModifiedComponents(repo, 'main; touch ' + sentinel);
    assert(result.error && result.error.startsWith('bad_ref'),
      `Expected bad_ref error, got: ${result.error}`);
    assert(!fs.existsSync(sentinel), 'injected command must not have run');
  });

  test('option-lookalike ref (leading dash) is rejected', () => {
    const result = getModifiedComponents(repo, '--upload-pack=/bin/sh');
    assert(result.error && result.error.startsWith('bad_ref'),
      `Expected bad_ref error, got: ${result.error}`);
  });

  test('unknown-but-well-formed ref returns bad_ref', () => {
    const result = getModifiedComponents(repo, 'no-such-branch-xyz');
    assert(result.error && result.error.startsWith('bad_ref'),
      `Expected bad_ref error, got: ${result.error}`);
  });

  test('isSafeGitRef allows real refs and rejects hostile ones', () => {
    assert(isSafeGitRef('main') && isSafeGitRef('origin/main') &&
      isSafeGitRef('release/1.2') && isSafeGitRef('a1b2c3d'), 'real refs must pass');
    assert(!isSafeGitRef('main;rm -rf /') && !isSafeGitRef('a..b') &&
      !isSafeGitRef('-x') && !isSafeGitRef('$(id)'), 'hostile refs must fail');
  });
});

// ─── Clean tree ─────────────────────────────────────────────────────

section('Clean tree (honest empty)', () => {
  test('clean working tree returns note, no error, zero files', () => {
    const result = getModifiedComponents(repo);
    assert(!result.error, `unexpected error: ${result.error}`);
    assert(result.totalFiles === 0 && result.totalComponents === 0, 'expected zero files/components');
    assert(result.note && result.note.includes('working tree clean'),
      `note should explain clean tree, got: ${result.note}`);
    assert(result.base === 'HEAD', 'default base is HEAD');
    assert(result.gitRoot === realRepo, `gitRoot should be repo root, got ${result.gitRoot}`);
  });
});

// ─── Working-tree detection (base=HEAD) ─────────────────────────────

section('Working-tree detection (base=HEAD)', () => {
  test('untracked new component file is detected with its component', () => {
    write(repo, 'src/NewThing.tsx', HEADER + `export function NewThing() { return <p>new</p>; }\n`);
    const result = getModifiedComponents(repo);
    const entry = result.files.find(f => f.file === 'src/NewThing.tsx');
    assert(entry, 'untracked file should appear');
    assert(entry.status === 'untracked', `expected untracked, got ${entry.status}`);
    assert(entry.absolutePath === path.join(realRepo, 'src/NewThing.tsx'), 'absolutePath = gitRoot + file');
    assert(entry.components.some(c => c.name === 'NewThing' && c.kind === 'functional'),
      `NewThing component should be listed, got ${JSON.stringify(entry.components)}`);
  });

  test('modified tracked file is detected vs HEAD', () => {
    write(repo, 'src/App.tsx', APP + '// dirty edit\n');
    const result = getModifiedComponents(repo);
    const entry = result.files.find(f => f.file === 'src/App.tsx');
    assert(entry, 'modified file should appear');
    assert(entry.status === 'modified', `expected modified, got ${entry.status}`);
    assert(entry.components.some(c => c.name === 'App'), 'App component should be listed');
  });

  test('multi-component file lists ALL components with kinds', () => {
    write(repo, 'src/Multi.tsx', MULTI + '// dirty edit\n');
    const result = getModifiedComponents(repo);
    const entry = result.files.find(f => f.file === 'src/Multi.tsx');
    assert(entry, 'Multi.tsx should appear');
    const names = entry.components.map(c => c.name).sort();
    assert(JSON.stringify(names) === JSON.stringify(['ErrorBoundary', 'Footer', 'Header']),
      `expected all 3 components, got ${JSON.stringify(names)}`);
    const kinds = Object.fromEntries(entry.components.map(c => [c.name, c.kind]));
    assert(kinds.Header === 'functional' && kinds.Footer === 'functional', 'functions/arrows are functional');
    assert(kinds.ErrorBoundary === 'class', 'class components are kind=class');
  });

  test('changed file with no components still appears with empty components', () => {
    write(repo, 'src/utils.ts', UTILS + '// tweak\n');
    const result = getModifiedComponents(repo);
    const entry = result.files.find(f => f.file === 'src/utils.ts');
    assert(entry, 'component-less changed file must not be silently dropped');
    assert(Array.isArray(entry.components) && entry.components.length === 0,
      `expected empty components, got ${JSON.stringify(entry.components)}`);
  });

  test('absolute-path matching: only the modified index.tsx appears (no basename cross-match)', () => {
    write(repo, 'src/widget/index.tsx', WIDGET_INDEX + '// dirty edit\n');
    const result = getModifiedComponents(repo);
    const widget = result.files.find(f => f.file === 'src/widget/index.tsx');
    const panel = result.files.find(f => f.file === 'src/panel/index.tsx');
    assert(widget, 'modified widget/index.tsx should appear');
    assert(!panel, 'untouched panel/index.tsx must NOT appear via basename match');
    assert(widget.components.some(c => c.name === 'Widget'), 'Widget listed');
    assert(!widget.components.some(c => c.name === 'Panel'), 'Panel must not leak into widget entry');
  });

  test('totals are consistent and non-tracked extensions are ignored', () => {
    write(repo, 'README-scratch.md', '# not a component file\n');
    const result = getModifiedComponents(repo);
    assert(result.totalFiles === result.files.length, 'totalFiles matches files array');
    const sum = result.files.reduce((s, f) => s + f.components.length, 0);
    assert(result.totalComponents === sum, 'totalComponents matches sum');
    assert(!result.files.some(f => f.file.endsWith('.md')), '.md files excluded');
    assert(JSON.stringify(TRACKED_EXTENSIONS) === JSON.stringify(['.tsx', '.jsx', '.ts', '.js']),
      'TRACKED_EXTENSIONS constant');
  });

  test('staged-only file reports status staged', () => {
    write(repo, 'src/App.tsx', APP + '// staged edit\n');
    git(repo, ['add', 'src/App.tsx']);
    try {
      const result = getModifiedComponents(repo);
      const entry = result.files.find(f => f.file === 'src/App.tsx');
      assert(entry, 'staged file should appear');
      assert(entry.status === 'staged', `expected staged, got ${entry.status}`);
    } finally {
      git(repo, ['reset', '-q', 'HEAD', 'src/App.tsx']);
    }
  });
});

// ─── Helpers ────────────────────────────────────────────────────────

section('isFileModified / getModifiedFileSet', () => {
  test('isFileModified true for dirty file, false for clean file', () => {
    assert(isFileModified(path.join(repo, 'src/App.tsx')) === true, 'dirty App.tsx');
    assert(isFileModified(path.join(repo, 'src/panel/index.tsx')) === false, 'clean panel/index.tsx');
  });

  test('isFileModified false outside a git repo', () => {
    const p = write(nonGitDir, 'loose.tsx', APP);
    assert(isFileModified(p) === false, 'non-repo file is never "modified"');
  });

  test('getModifiedFileSet returns ABSOLUTE paths (not basenames)', () => {
    const set = getModifiedFileSet(repo);
    assert(set.has(path.join(realRepo, 'src/App.tsx')), 'absolute path present');
    assert(!set.has('App.tsx') && !set.has('index.tsx'), 'no basenames in the set');
    assert(set.has(path.join(realRepo, 'src/widget/index.tsx')), 'modified index.tsx by full path');
    assert(!set.has(path.join(realRepo, 'src/panel/index.tsx')), 'clean index.tsx absent');
  });
});

// ─── PR-scoped diff (base=main) ─────────────────────────────────────

section('PR-scoped diff (base=main)', () => {
  // Commit current mess onto a feature branch, add one more component there.
  git(repo, ['checkout', '-q', '-b', 'feature']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'feature-work']);
  write(repo, 'src/Extra.tsx', HEADER + `export function Extra() { return <b>x</b>; }\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'more-feature-work']);

  test('base="main" returns the branch\'s committed changes', () => {
    const result = getModifiedComponents(repo, 'main');
    assert(!result.error, `unexpected error: ${result.error}`);
    assert(result.base === 'main', 'result.base echoes the compared ref');
    const files = result.files.map(f => f.file);
    assert(files.includes('src/Extra.tsx'), 'committed new file since main');
    assert(files.includes('src/App.tsx'), 'committed modification since main');
    const extra = result.files.find(f => f.file === 'src/Extra.tsx');
    assert(extra.status === 'added', `Extra.tsx is added, got ${extra.status}`);
    assert(extra.components.some(c => c.name === 'Extra'), 'Extra component listed');
  });

  test('base="HEAD" on a clean tree ignores committed branch work', () => {
    const result = getModifiedComponents(repo);
    assert(result.totalFiles === 0, 'no working-tree changes after commit');
    assert(result.note && result.note.includes('working tree clean'), 'clean note present');
  });

  test('no changes vs same ref yields honest-empty note naming the base', () => {
    const result = getModifiedComponents(repo, 'feature');
    assert(!result.error, `unexpected error: ${result.error}`);
    assert(result.totalFiles === 0, 'feature...HEAD is empty');
    assert(result.note && result.note.includes('feature'), `note names the base, got: ${result.note}`);
  });
});

// ─── Cleanup + summary ──────────────────────────────────────────────

fs.rmSync(repo, { recursive: true, force: true });
fs.rmSync(nonGitDir, { recursive: true, force: true });

console.log('\n' + '='.repeat(50));
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));
process.exit(failed > 0 ? 1 : 0);
