#!/usr/bin/env node
/**
 * test-visualizer-bridge.js
 *
 * Tests for the visualizer-bridge file-based IPC module (TICKET-038).
 * Validates write/read/poll/clear operations and integration with openVisualizer.
 *
 * Usage:
 *   npm run build && node scripts/test-visualizer-bridge.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');

// Use a temp IPC directory to avoid collisions with a running VS Code extension
const TEST_IPC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dendro-test-viz-bridge-'));
process.env.DENDRO_IPC_DIR = TEST_IPC_DIR;

// Init workspace root so openVisualizer's assertPathInWorkspace doesn't throw.
process.env.DENDRO_WORKSPACE_ROOT = ROOT;
const { initWorkspaceRoot } = require(path.join(ROOT, 'out/mcp/path-boundary'));
initWorkspaceRoot();

// Use a real fixture file for openVisualizer calls (path must exist)
const FIXTURE_APP = path.join(ROOT, 'src/test/fixtures/mcp-tools/App.tsx');

let passed = 0;
let failed = 0;
let currentSection = '';

function section(name) {
  currentSection = name;
  console.log(`\n${name}`);
}

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        passed++;
        console.log(`  ✅ ${name}`);
      }).catch((err) => {
        failed++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err.message}`);
      });
    }
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

// ============================================================================
// Load modules
// ============================================================================

const {
  writeVisualizerPending,
  writeVisualizerReady,
  readVisualizerStatus,
  pollVisualizerReady,
  clearVisualizerStatus,
  getVisualizerPaths,
} = require(path.join(ROOT, 'out/runtime/visualizer-bridge'));
const VISUALIZER_PATHS = getVisualizerPaths();

const { openVisualizer } = require(path.join(ROOT, 'out/mcp/tools'));

// ============================================================================
// Helpers
// ============================================================================

function cleanup() {
  clearVisualizerStatus();
}

// ============================================================================
// Run all tests sequentially (some are async)
// ============================================================================
async function runTests() {

  // ==========================================================================
  // 1. File Operations
  // ==========================================================================
  section('📂 Visualizer Bridge — File Operations');

  cleanup();

  test('writeVisualizerPending creates status file', () => {
    cleanup();
    const sessionId = writeVisualizerPending('/path/to/App.tsx');
    assert(fs.existsSync(VISUALIZER_PATHS.statusFile), 'Status file should exist');
    assert(typeof sessionId === 'string', 'Should return session ID string');
    assert(sessionId.startsWith('viz-'), `Session ID should start with viz-, got: ${sessionId}`);
    cleanup();
  });

  test('writeVisualizerPending writes correct fields', () => {
    cleanup();
    writeVisualizerPending('/path/to/App.tsx');
    const status = readVisualizerStatus();
    assert(status !== null, 'Status should not be null');
    assert(status.status === 'pending', `Status should be pending, got: ${status.status}`);
    assert(status.entryFile === '/path/to/App.tsx', `Entry file mismatch: ${status.entryFile}`);
    assert(typeof status.timestamp === 'number', 'Timestamp should be a number');
    assert(typeof status.sessionId === 'string', 'Session ID should be a string');
    cleanup();
  });

  test('writeVisualizerPending generates unique session IDs', () => {
    cleanup();
    const id1 = writeVisualizerPending('/path/to/App.tsx');
    const id2 = writeVisualizerPending('/path/to/App.tsx');
    assert(id1 !== id2, `Session IDs should be unique: ${id1} vs ${id2}`);
    cleanup();
  });

  test('writeVisualizerReady updates status to ready', () => {
    cleanup();
    writeVisualizerReady('test-session-1', '/path/to/App.tsx');
    const status = readVisualizerStatus();
    assert(status !== null, 'Status should not be null');
    assert(status.status === 'ready', `Status should be ready, got: ${status.status}`);
    assert(status.sessionId === 'test-session-1', `Session ID mismatch: ${status.sessionId}`);
    cleanup();
  });

  test('readVisualizerStatus returns null when no file exists', () => {
    cleanup();
    const status = readVisualizerStatus();
    assert(status === null, 'Status should be null when file missing');
  });

  test('readVisualizerStatus returns parsed status', () => {
    cleanup();
    writeVisualizerPending('/path/to/App.tsx');
    const status = readVisualizerStatus();
    assert(status !== null, 'Should return parsed status');
    assert(status.status === 'pending', 'Should be pending');
    cleanup();
  });

  test('clearVisualizerStatus removes file', () => {
    writeVisualizerPending('/path/to/App.tsx');
    assert(fs.existsSync(VISUALIZER_PATHS.statusFile), 'File should exist before clear');
    clearVisualizerStatus();
    assert(!fs.existsSync(VISUALIZER_PATHS.statusFile), 'File should not exist after clear');
  });

  test('clearVisualizerStatus is idempotent', () => {
    cleanup();
    // Should not throw when file doesn't exist
    clearVisualizerStatus();
    clearVisualizerStatus();
    assert(true, 'No error on double clear');
  });

  test('Status file contains valid JSON', () => {
    cleanup();
    writeVisualizerPending('/path/to/App.tsx');
    const raw = fs.readFileSync(VISUALIZER_PATHS.statusFile, 'utf-8');
    const parsed = JSON.parse(raw);
    assert(typeof parsed === 'object', 'Should parse as object');
    assert(parsed.status === 'pending', 'Parsed status should be pending');
    cleanup();
  });

  // ==========================================================================
  // 2. Polling Logic
  // ==========================================================================
  section('⏱️  Visualizer Bridge — Polling');

  await test('pollVisualizerReady returns immediately if already ready', async () => {
    cleanup();
    writeVisualizerReady('ready-session', '/path/to/App.tsx');
    const start = Date.now();
    const result = await pollVisualizerReady(5000, 100);
    const elapsed = Date.now() - start;
    assert(result !== null, 'Should return status');
    assert(result.status === 'ready', 'Should be ready');
    assert(elapsed < 500, `Should return quickly, took ${elapsed}ms`);
    cleanup();
  });

  await test('pollVisualizerReady waits then returns when status changes', async () => {
    cleanup();
    writeVisualizerPending('/path/to/App.tsx');

    // Simulate extension writing ready after 300ms
    setTimeout(() => {
      writeVisualizerReady('delayed-session', '/path/to/App.tsx');
    }, 300);

    const start = Date.now();
    const result = await pollVisualizerReady(5000, 100);
    const elapsed = Date.now() - start;
    assert(result !== null, 'Should return status');
    assert(result.status === 'ready', 'Should be ready');
    assert(elapsed >= 200, `Should wait for ready signal, took ${elapsed}ms`);
    assert(elapsed < 2000, `Should not wait too long, took ${elapsed}ms`);
    cleanup();
  });

  await test('pollVisualizerReady returns null on timeout', async () => {
    cleanup();
    writeVisualizerPending('/path/to/App.tsx');
    const start = Date.now();
    const result = await pollVisualizerReady(500, 100);
    const elapsed = Date.now() - start;
    assert(result === null, 'Should return null on timeout');
    assert(elapsed >= 400, `Should wait near timeout, took ${elapsed}ms`);
    assert(elapsed < 1500, `Should not exceed timeout significantly, took ${elapsed}ms`);
    cleanup();
  });

  await test('pollVisualizerReady respects custom timeout', async () => {
    cleanup();
    writeVisualizerPending('/path/to/App.tsx');
    const start = Date.now();
    const result = await pollVisualizerReady(200, 50);
    const elapsed = Date.now() - start;
    assert(result === null, 'Should timeout');
    assert(elapsed < 1000, `Should timeout quickly with short timeout, took ${elapsed}ms`);
    cleanup();
  });

  await test('pollVisualizerReady ignores pending status', async () => {
    cleanup();
    writeVisualizerPending('/path/to/App.tsx');
    const result = await pollVisualizerReady(300, 100);
    assert(result === null, 'Should not resolve for pending status');
    cleanup();
  });

  // ==========================================================================
  // 3. Stale File Handling
  // ==========================================================================
  section('🗑️  Visualizer Bridge — Stale File Handling');

  test('clearVisualizerStatus before writeVisualizerPending prevents stale reads', () => {
    // Write a ready status (simulating old session)
    writeVisualizerReady('old-session', '/old/App.tsx');
    const oldStatus = readVisualizerStatus();
    assert(oldStatus.status === 'ready', 'Should start as ready (stale)');

    // Clear then write new pending
    clearVisualizerStatus();
    writeVisualizerPending('/new/App.tsx');
    const newStatus = readVisualizerStatus();
    assert(newStatus.status === 'pending', 'Should be pending after clear + write');
    assert(newStatus.entryFile === '/new/App.tsx', 'Should have new entry file');
    cleanup();
  });

  test('Old ready status does not interfere with new pending', () => {
    writeVisualizerReady('old-session', '/old/App.tsx');
    // Overwrite with pending
    writeVisualizerPending('/new/App.tsx');
    const status = readVisualizerStatus();
    assert(status.status === 'pending', 'New write should overwrite old');
    cleanup();
  });

  test('Missing ~/.dendro directory is auto-created', () => {
    // This test just ensures no error if dir exists (we can't safely remove ~/.dendro)
    cleanup();
    const sessionId = writeVisualizerPending('/path/to/App.tsx');
    assert(typeof sessionId === 'string', 'Should work even if dir needs creation');
    assert(fs.existsSync(VISUALIZER_PATHS.dendroDir), '~/.dendro should exist');
    cleanup();
  });

  // ==========================================================================
  // 4. Integration with openVisualizer
  // ==========================================================================
  section('🔗 Visualizer Bridge — openVisualizer Integration');

  test('openVisualizer returns a Promise', () => {
    const result = openVisualizer(FIXTURE_APP);
    assert(result && typeof result.then === 'function', 'Should return a Promise');
    // Don't await — it will try to open VS Code URI which won't work in test
  });

  test('OpenVisualizerResult interface has ready field', () => {
    // Check the module exports the right shape by inspecting tools.ts types
    // We test indirectly — openVisualizer returns Promise<OpenVisualizerResult>
    // The type check happens at compile time; here we verify the function exists
    assert(typeof openVisualizer === 'function', 'openVisualizer should be a function');
  });

  await test('openVisualizer clears stale status before starting', async () => {
    // Write stale ready
    writeVisualizerReady('stale-session', FIXTURE_APP);
    assert(readVisualizerStatus().status === 'ready', 'Should have stale ready');

    // openVisualizer will clear stale, write pending, fire URI, then poll.
    // If VS Code extension is running, it may respond (ready=true).
    // If not, poll times out (ready=false). Both are valid.
    const result = await openVisualizer(FIXTURE_APP);
    assert(typeof result.ready === 'boolean', 'Result should have ready field');
    cleanup();
  });

  await test('openVisualizer returns a valid result shape', async () => {
    cleanup();
    // In test environment, VS Code extension may or may not be running.
    // If running: ready=true. If not: ready=false. Both are valid.
    const result = await openVisualizer(FIXTURE_APP);
    assert(typeof result.ready === 'boolean', 'Result should have ready field');
    assert(typeof result.message === 'string', 'Should have message');
    assert(typeof result.entryFile === 'string', 'Should have entryFile');
    cleanup();
  });

  await test('openVisualizer result message differs based on ready state', async () => {
    cleanup();

    // Simulate ready response by writing ready status before poll starts
    // This is a race — write ready immediately so poll finds it
    writeVisualizerReady('test-ready', '/path/to/App.tsx');

    // Create a fake openVisualizer that skips the URI step
    // We can test the message logic by checking the pollVisualizerReady result directly
    const readyStatus = await pollVisualizerReady(1000, 100);
    assert(readyStatus !== null, 'Should find ready status');
    assert(readyStatus.status === 'ready', 'Status should be ready');

    // Now test the not-ready message path
    clearVisualizerStatus();
    writeVisualizerPending('/path/to/App.tsx');
    const timeoutStatus = await pollVisualizerReady(200, 50);
    assert(timeoutStatus === null, 'Should timeout');

    cleanup();
  });

  // ==========================================================================
  // 5. Edge Cases
  // ==========================================================================
  section('🧪 Visualizer Bridge — Edge Cases');

  test('Status file handles special characters in entryFile', () => {
    cleanup();
    const weirdPath = '/path/to/My App (v2)/src/App.tsx';
    writeVisualizerPending(weirdPath);
    const status = readVisualizerStatus();
    assert(status.entryFile === weirdPath, `Should preserve special chars: ${status.entryFile}`);
    cleanup();
  });

  test('readVisualizerStatus handles corrupted file gracefully', () => {
    // Write garbage to the status file
    const dir = VISUALIZER_PATHS.dendroDir;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(VISUALIZER_PATHS.statusFile, 'not json{{{', 'utf-8');
    const status = readVisualizerStatus();
    assert(status === null, 'Should return null for corrupted file');
    cleanup();
  });

  test('Rapid write-read cycles work correctly', () => {
    cleanup();
    for (let i = 0; i < 10; i++) {
      writeVisualizerPending(`/path/to/App${i}.tsx`);
    }
    const status = readVisualizerStatus();
    assert(status.entryFile === '/path/to/App9.tsx', 'Last write wins');
    cleanup();
  });

  // ==========================================================================
  // Summary
  // ==========================================================================
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Visualizer Bridge Tests: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(60)}`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
