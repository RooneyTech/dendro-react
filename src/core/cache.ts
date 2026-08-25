/**
 * 2-Tier LRU Cache for Parse Results
 *
 * Tier 1: In-memory LRU cache (fast, volatile)
 * Tier 2: VS Code workspace state (persistent, slower)
 *
 * Cache keys use content hashing to detect actual file changes
 * rather than relying on timestamps.
 *
 * @module cache
 */

import { LRUCache } from 'lru-cache';
import { createHash } from 'crypto';
import type { ParseResult } from 'oxc-parser';

// Parser version - bump this when parser output format changes
export const PARSER_VERSION = '1.1.0'; // 1.1.0: #40 — asset imports excluded, .ts needs createElement

/**
 * Cached component information extracted from parse results
 */
export interface CachedComponentInfo {
  type: 'functional' | 'class' | null;
  stateVariables: string[];
  memoized?: boolean;
}

/**
 * Import information extracted from parse results
 */
export interface CachedImport {
  source: string;
  isLocal: boolean;
}

/**
 * Export information for barrel file resolution
 */
export interface CachedExport {
  source: string;
  names: string[] | '*';
}

/**
 * Complete cache entry for a parsed file
 */
export interface CachedEntry {
  filePath: string;
  contentHash: string;
  parserVersion: string;
  componentInfo: CachedComponentInfo;
  imports: CachedImport[];
  exports: CachedExport[];
  timestamp: number;
  // Store the raw parse result for tools that need full AST access
  parseResult?: ParseResult;
}

/**
 * Serializable version of CachedEntry for workspace state
 * (ParseResult is too large to store, so we omit it)
 */
export interface SerializableCachedEntry {
  filePath: string;
  contentHash: string;
  parserVersion: string;
  componentInfo: CachedComponentInfo;
  imports: CachedImport[];
  exports: CachedExport[];
  timestamp: number;
}

/**
 * Cache statistics for monitoring
 */
export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  tier1Size: number;
  tier2Size: number;
}

/**
 * VS Code Memento interface (for type safety without importing vscode)
 */
interface Memento {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
  keys(): readonly string[];
}

// Cache key prefix for workspace state
const CACHE_KEY_PREFIX = 'dendro:parse:';

// Maximum entries to store in workspace state
const MAX_WORKSPACE_ENTRIES = 200;

/**
 * Hash file content using MD5
 * MD5 is fast and sufficient for cache invalidation (not security)
 */
export function hashContent(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

/**
 * Generate a cache key from file path and content
 */
export function makeCacheKey(filePath: string, contentHash: string): string {
  return `${filePath}:${contentHash}:${PARSER_VERSION}`;
}

/**
 * 2-Tier Parse Cache
 *
 * Usage:
 * - MCP server: new ParseCache() - memory only
 * - VS Code extension: new ParseCache(context.workspaceState)
 */
export class ParseCache {
  private memoryCache: LRUCache<string, CachedEntry>;
  private workspaceState?: Memento;
  private stats: CacheStats;

  constructor(workspaceState?: Memento) {
    this.memoryCache = new LRUCache<string, CachedEntry>({
      max: 500,
      ttl: 1000 * 60 * 60, // 1 hour TTL
      updateAgeOnGet: true,
    });
    this.workspaceState = workspaceState;
    this.stats = {
      hits: 0,
      misses: 0,
      size: 0,
      tier1Size: 0,
      tier2Size: 0,
    };
  }

  /**
   * Get a cached entry by file path and content
   * Checks Tier 1 (memory) first, then Tier 2 (workspace state)
   */
  get(filePath: string, content: string): CachedEntry | null {
    const contentHash = hashContent(content);
    const key = makeCacheKey(filePath, contentHash);

    // Tier 1: Memory cache
    const memoryEntry = this.memoryCache.get(key);
    if (memoryEntry) {
      this.stats.hits++;
      return memoryEntry;
    }

    // Tier 2: Workspace state (if available)
    if (this.workspaceState) {
      const workspaceKey = CACHE_KEY_PREFIX + key;
      const storedEntry = this.workspaceState.get<SerializableCachedEntry>(workspaceKey);

      if (storedEntry && storedEntry.parserVersion === PARSER_VERSION) {
        // Promote to Tier 1 (without parseResult since it wasn't stored)
        const entry: CachedEntry = {
          ...storedEntry,
          parseResult: undefined,
        };
        this.memoryCache.set(key, entry);
        this.stats.hits++;
        return entry;
      }
    }

    this.stats.misses++;
    return null;
  }

  /**
   * Store an entry in both cache tiers
   */
  async set(filePath: string, content: string, entry: CachedEntry): Promise<void> {
    const contentHash = hashContent(content);
    const key = makeCacheKey(filePath, contentHash);

    // Tier 1: Memory cache (store full entry with parseResult)
    this.memoryCache.set(key, entry);

    // Tier 2: Workspace state (store without parseResult - too large)
    if (this.workspaceState) {
      const workspaceKey = CACHE_KEY_PREFIX + key;
      const serializableEntry: SerializableCachedEntry = {
        filePath: entry.filePath,
        contentHash: entry.contentHash,
        parserVersion: entry.parserVersion,
        componentInfo: entry.componentInfo,
        imports: entry.imports,
        exports: entry.exports,
        timestamp: entry.timestamp,
      };

      // Check workspace state size and clean up if needed
      await this.pruneWorkspaceState();
      await this.workspaceState.update(workspaceKey, serializableEntry);
    }

    this.updateStats();
  }

  /**
   * Invalidate a single file's cache entry
   * Called when a file is modified or deleted
   */
  invalidate(filePath: string): void {
    // Remove all entries for this file path (any content hash)
    const keysToDelete: string[] = [];

    // Check memory cache
    for (const key of this.memoryCache.keys()) {
      if (key.startsWith(filePath + ':')) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.memoryCache.delete(key);
    }

    // Check workspace state
    if (this.workspaceState) {
      const wsKeys = this.workspaceState.keys();
      for (const key of wsKeys) {
        if (key.startsWith(CACHE_KEY_PREFIX + filePath + ':')) {
          this.workspaceState.update(key, undefined);
        }
      }
    }

    this.updateStats();
  }

  /**
   * Clear all cache entries
   * Called on parser version change or manual clear
   */
  clear(): void {
    this.memoryCache.clear();

    if (this.workspaceState) {
      const wsKeys = this.workspaceState.keys();
      for (const key of wsKeys) {
        if (key.startsWith(CACHE_KEY_PREFIX)) {
          this.workspaceState.update(key, undefined);
        }
      }
    }

    this.stats = {
      hits: 0,
      misses: 0,
      size: 0,
      tier1Size: 0,
      tier2Size: 0,
    };
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    this.updateStats();
    return { ...this.stats };
  }

  /**
   * Get the cache hit ratio
   */
  getHitRatio(): number {
    const total = this.stats.hits + this.stats.misses;
    if (total === 0) return 0;
    return this.stats.hits / total;
  }

  /**
   * Prune workspace state if it exceeds the limit
   * Removes oldest entries based on timestamp
   */
  private async pruneWorkspaceState(): Promise<void> {
    if (!this.workspaceState) return;

    const wsKeys = this.workspaceState.keys().filter(k => k.startsWith(CACHE_KEY_PREFIX));

    if (wsKeys.length < MAX_WORKSPACE_ENTRIES) return;

    // Collect entries with timestamps
    const entries: Array<{ key: string; timestamp: number }> = [];
    for (const key of wsKeys) {
      const entry = this.workspaceState.get<SerializableCachedEntry>(key);
      if (entry) {
        entries.push({ key, timestamp: entry.timestamp });
      }
    }

    // Sort by timestamp (oldest first) and remove oldest 20%
    entries.sort((a, b) => a.timestamp - b.timestamp);
    const toRemove = Math.floor(entries.length * 0.2);

    for (let i = 0; i < toRemove; i++) {
      await this.workspaceState.update(entries[i].key, undefined);
    }
  }

  /**
   * Update internal statistics
   */
  private updateStats(): void {
    this.stats.tier1Size = this.memoryCache.size;

    if (this.workspaceState) {
      this.stats.tier2Size = this.workspaceState.keys()
        .filter(k => k.startsWith(CACHE_KEY_PREFIX)).length;
    }

    this.stats.size = this.stats.tier1Size;
  }
}

/**
 * Singleton cache instance for MCP server (no workspace state)
 */
export const mcpCache = new ParseCache();

/**
 * Factory function to create a cache with VS Code workspace state
 */
export function createExtensionCache(workspaceState: Memento): ParseCache {
  return new ParseCache(workspaceState);
}
