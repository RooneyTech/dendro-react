/**
 * Local-only MCP tool usage telemetry.
 *
 * Writes to ~/.dendro/telemetry.json — never leaves the machine.
 * Tracks which tools are invoked, how often, and when.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DENDRO_DIR = path.join(os.homedir(), '.dendro');
const TELEMETRY_FILE = path.join(DENDRO_DIR, 'telemetry.json');

interface ToolStats {
  count: number;
  firstUsed: string;   // ISO 8601
  lastUsed: string;     // ISO 8601
  errorCount: number;
  lastError: string | null;
}

interface WebviewErrorEntry {
  kind: string;          // 'error' | 'unhandledrejection'
  message: string;
  stack?: string;
  sessionId?: string;
  timestamp: string;     // ISO 8601
}

interface TelemetryData {
  version: 1;
  tools: Record<string, ToolStats>;
  webviewErrors?: WebviewErrorEntry[];
}

/** Keep only the most recent webview errors — this is a diagnostics ring, not a log. */
const MAX_WEBVIEW_ERRORS = 50;

let cache: TelemetryData | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function load(): TelemetryData {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(TELEMETRY_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (data?.version === 1 && data.tools) {
      cache = data as TelemetryData;
      return cache;
    }
  } catch {
    // File doesn't exist or is corrupt — start fresh
  }
  cache = { version: 1, tools: {} };
  return cache;
}

function scheduleSave(): void {
  // Debounce writes — flush at most once per second
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (!cache) return;
    try {
      if (!fs.existsSync(DENDRO_DIR)) {
        fs.mkdirSync(DENDRO_DIR, { recursive: true });
      }
      fs.writeFileSync(TELEMETRY_FILE, JSON.stringify(cache, null, 2));
    } catch {
      // Best-effort — don't crash the server over telemetry
    }
  }, 1000);
}

/**
 * Record a tool invocation. Called automatically by the server wrapper.
 */
export function recordToolUsage(toolName: string): void {
  const data = load();
  const now = new Date().toISOString();
  const existing = data.tools[toolName];
  if (existing) {
    existing.count += 1;
    existing.lastUsed = now;
  } else {
    data.tools[toolName] = { count: 1, firstUsed: now, lastUsed: now, errorCount: 0, lastError: null };
  }
  scheduleSave();
}

/**
 * Record a tool error. Called by the server wrapper on handler failure.
 */
export function recordToolError(toolName: string, error: string): void {
  const data = load();
  const now = new Date().toISOString();
  const existing = data.tools[toolName];
  if (existing) {
    existing.errorCount = (existing.errorCount || 0) + 1;
    existing.lastError = error;
  } else {
    data.tools[toolName] = { count: 0, firstUsed: now, lastUsed: now, errorCount: 1, lastError: error };
  }
  scheduleSave();
}

/**
 * Record an uncaught error reported by a webview (visualizer/runtime panel).
 * Called by the extension when it receives a 'webviewError' message.
 */
export function recordWebviewError(entry: { kind: string; message: string; stack?: string; sessionId?: string }): void {
  const data = load();
  if (!data.webviewErrors) data.webviewErrors = [];
  data.webviewErrors.push({ ...entry, timestamp: new Date().toISOString() });
  if (data.webviewErrors.length > MAX_WEBVIEW_ERRORS) {
    data.webviewErrors.splice(0, data.webviewErrors.length - MAX_WEBVIEW_ERRORS);
  }
  scheduleSave();
}

/**
 * Get current telemetry data. Used by the get_usage_stats tool.
 */
export function getUsageStats(): TelemetryData {
  return load();
}
