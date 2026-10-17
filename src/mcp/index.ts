#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server';
import { initWorkspaceRoot, getWorkspaceRoot } from './path-boundary';
import { computeWorkspaceHash } from '../runtime/ipc-paths';

async function main(): Promise<void> {
  initWorkspaceRoot();

  // Derive workspace hash from workspace root for IPC namespace isolation (TICKET-056)
  if (!process.env.DENDRO_WORKSPACE_HASH) {
    const root = getWorkspaceRoot();
    if (root) {
      process.env.DENDRO_WORKSPACE_HASH = computeWorkspaceHash(root);
    }
  }
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.close();
    process.exit(0);
  });
}

main().catch((error: Error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
