/** Correlated, workspace-local receipts for MCP → extension → rendered webview batches. */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ensureDir, getWorkspaceIpcDir } from './ipc-paths';

export type BatchStatus = 'queued' | 'running' | 'waiting_for_user' | 'completed' | 'partial' | 'failed' | 'skipped' | 'superseded';
export interface BatchCommandResult {
  index: number;
  commandType: string;
  success: boolean;
  rendered: boolean;
  matched?: string[];
  notFound?: string[];
  matchedCount?: number;
  notFoundCount?: number;
  omitted?: { matched: number; notFound: number };
  error?: string;
}
export interface BatchReceipt {
  requestId: string;
  commandTypes: string[];
  commandCount: number;
  waitForUser: boolean;
  sessionId?: string;
  status: BatchStatus;
  results: BatchCommandResult[];
  createdAt: number;
  updatedAt: number;
  error?: string;
}
const isId = (id: string): boolean => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id);
const terminal = new Set<BatchStatus>(['completed', 'partial', 'failed', 'skipped', 'superseded']);
const directory = (): string => path.join(getWorkspaceIpcDir(), 'visualization-batches');
const receiptPath = (id: string): string => {
  if (!isId(id)) throw new Error('Invalid visualization request ID');
  return path.join(directory(), `${id}.json`);
};
function write(receipt: BatchReceipt): void {
  ensureDir(directory());
  const destination = receiptPath(receipt.requestId);
  const temp = destination + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(receipt), { mode: 0o600 });
    fs.renameSync(temp, destination);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function readBatchReceipt(id: string): BatchReceipt | null {
  try {
    const file = receiptPath(id);
    if (fs.statSync(file).size > 2_000_000) return null;
    const r = JSON.parse(fs.readFileSync(file, 'utf8')) as BatchReceipt;
    return r.requestId === id && Array.isArray(r.commandTypes) && r.commandTypes.every(t => typeof t === 'string') &&
      r.commandTypes.length === r.commandCount && r.commandCount > 0 && r.commandCount <= 100 &&
      Array.isArray(r.results) && r.results.length <= r.commandCount && typeof r.waitForUser === 'boolean' &&
      Number.isFinite(r.createdAt) && Date.now() - r.createdAt >= 0 && Date.now() - r.createdAt < 86_400_000
      ? r : null;
  } catch { return null; }
}
export function createBatchReceipt(commandTypes: string[], waitForUser: boolean): BatchReceipt {
  ensureDir(directory());
  // Only our expired receipt files are removed; active manual walkthroughs are retained.
  for (const file of fs.readdirSync(directory())) {
    if (!file.endsWith('.json') || !isId(file.slice(0, -5))) continue;
    try {
      const target = path.join(directory(), file);
      if (Date.now() - fs.statSync(target).mtimeMs >= 86_400_000) fs.unlinkSync(target);
    } catch { /* Another process may already have expired the receipt. */ }
  }
  const now = Date.now();
  const receipt: BatchReceipt = { requestId: randomUUID(), commandTypes, commandCount: commandTypes.length,
    waitForUser, status: 'queued', results: [], createdAt: now, updatedAt: now };
  write(receipt);
  return receipt;
}
export function bindBatchSession(id: string, sessionId: string, commandTypes: string[]): boolean {
  const r = readBatchReceipt(id);
  if (!r || terminal.has(r.status) || r.sessionId ||
      JSON.stringify(r.commandTypes) !== JSON.stringify(commandTypes)) return false;
  write({ ...r, sessionId, updatedAt: Date.now() });
  return true;
}
export function failBatch(id: string, error: string, sessionId?: string): void {
  const r = readBatchReceipt(id);
  if (!r || terminal.has(r.status) || (sessionId && r.sessionId !== sessionId) || (!sessionId && r.sessionId)) return;
  write({ ...r, status: 'failed', error: error.slice(0, 2000), updatedAt: Date.now() });
}
/** Only the panel to which this request was bound can acknowledge it. */
export function recordBatchResult(id: string, sessionId: string, message: unknown): boolean {
  const r = readBatchReceipt(id);
  if (!r || r.sessionId !== sessionId || terminal.has(r.status) || !message || typeof message !== 'object') return false;
  const m = message as { status?: string; results?: unknown[] };
  if (!['running', 'waiting_for_user', 'completed', 'skipped', 'superseded'].includes(m.status || '') ||
      !Array.isArray(m.results) || m.results.length > r.commandCount) return false;
  const results: BatchCommandResult[] = [];
  const indexes = new Set<number>();
  // Share a byte budget across the entire receipt. Keep full selectors or omit
  // them: truncating a path would turn it into an unusable follow-up target.
  let detailBytes = 250_000;
  for (const raw of m.results) {
    if (!raw || typeof raw !== 'object') return false;
    const item = raw as BatchCommandResult;
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= r.commandCount || indexes.has(item.index) ||
        item.commandType !== r.commandTypes[item.index] || typeof item.success !== 'boolean' || typeof item.rendered !== 'boolean') return false;
    indexes.add(item.index);
    const strings = (value: unknown): { values?: string[]; count: number; omitted: number } => {
      if (!Array.isArray(value)) return { count: 0, omitted: 0 };
      const values: string[] = [];
      let count = 0;
      for (const s of value) {
        if (typeof s !== 'string') continue;
        count++;
        const bytes = Buffer.byteLength(JSON.stringify(s), 'utf8') + 1;
        if (values.length < 1000 && bytes <= detailBytes) { values.push(s); detailBytes -= bytes; }
      }
      return { values, count, omitted: count - values.length };
    };
    const matched = strings(item.matched), notFound = strings(item.notFound);
    results.push({ index: item.index, commandType: item.commandType, success: item.success,
      rendered: item.rendered, matched: matched.values, notFound: notFound.values,
      matchedCount: matched.count, notFoundCount: notFound.count,
      ...(matched.omitted || notFound.omitted ? { omitted: { matched: matched.omitted, notFound: notFound.omitted } } : {}),
      error: typeof item.error === 'string' ? item.error.slice(0, 2000) : undefined });
  }
  let status = m.status as BatchStatus;
  if (status === 'completed') {
    if (results.length !== r.commandCount) return false;
    const confirmed = results.filter(x => x.success && x.rendered && !x.notFoundCount).length;
    status = confirmed === r.commandCount ? 'completed' : results.some(x => x.rendered) ? 'partial' : 'failed';
  }
  write({ ...r, status, results: results.sort((a, b) => a.index - b.index), updatedAt: Date.now() });
  return true;
}
export async function waitForBatchReceipt(id: string, timeoutMs: number): Promise<BatchReceipt | null> {
  const start = Date.now();
  while (true) {
    const r = readBatchReceipt(id);
    if (!r || terminal.has(r.status) || r.status === 'waiting_for_user' || Date.now() - start >= timeoutMs) return r;
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, timeoutMs - (Date.now() - start)))));
  }
}
