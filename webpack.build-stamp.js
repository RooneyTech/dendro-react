/**
 * Build-stamp DefinePlugin values, shared by all webpack configs.
 * Surfaced at runtime via src/mcp/build-info.ts so agents can detect a stale
 * running MCP server after a recompile (schema/behavior only refresh on
 * Claude restart — the stamp makes that visible).
 */
const { execSync } = require('child_process');

let gitSha = 'unknown';
try {
  gitSha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString().trim();
} catch {
  // not a git checkout (e.g. building from a tarball) — 'unknown' is fine
}

module.exports = {
  DENDRO_VERSION: JSON.stringify(require('./package.json').version),
  DENDRO_GIT_SHA: JSON.stringify(gitSha),
  DENDRO_BUILD_TIME: JSON.stringify(new Date().toISOString()),
};
