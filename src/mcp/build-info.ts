/**
 * Build identity for the running MCP server process.
 *
 * Why this exists: recompiling the server does NOT affect an already-running
 * Claude/MCP session — the old process keeps serving old code, silently. This
 * stamp, surfaced through get_usage_guide and get_usage_stats, lets an agent
 * (or a human) verify WHICH build is actually answering.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface BuildInfo {
  /** package.json version of this build. */
  version: string;
  /** Short git SHA the bundle was built from ('unknown' outside git / unbundled). */
  gitSha: string;
  /** ISO timestamp of the webpack build ('unbundled' for tsc-only out/ runs). */
  buildTime: string;
  /** When this server process started — compare with buildTime to spot staleness. */
  processStartedAt: string;
  pid: number;
}

const processStartedAt = new Date().toISOString();

function fallbackVersion(): string {
  // Unbundled (out/) run: __dirname is out/mcp, package.json two levels up.
  for (const rel of ['../../package.json', '../package.json']) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, rel), 'utf-8')) as { version?: string; name?: string };
      if (pkg.name === 'dendro-react' && pkg.version) return pkg.version;
    } catch { /* keep looking */ }
  }
  return 'unknown';
}

export function getBuildInfo(): BuildInfo {
  return {
    version: typeof DENDRO_VERSION !== 'undefined' ? DENDRO_VERSION : fallbackVersion(),
    gitSha: typeof DENDRO_GIT_SHA !== 'undefined' ? DENDRO_GIT_SHA : 'unknown',
    buildTime: typeof DENDRO_BUILD_TIME !== 'undefined' ? DENDRO_BUILD_TIME : 'unbundled',
    processStartedAt,
    pid: process.pid,
  };
}
