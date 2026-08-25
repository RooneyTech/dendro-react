/**
 * tsconfig/jsconfig path-alias resolution.
 *
 * Modern React codebases import via aliases (`@/components/x`), not relative
 * paths. Import-matching that only handles './' silently misses those edges —
 * get_used_by reported 0 importers for a component imported by every page of
 * a Next.js starter. This resolves alias imports to absolute path candidates.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface AliasEntry {
  /** Alias prefix with trailing '*' removed, e.g. "@/" */
  prefix: string;
  /** Absolute target prefixes, '*' removed, e.g. ["/abs/project/"] */
  targets: string[];
}

export interface AliasMap {
  configPath: string;
  aliases: AliasEntry[];
}

const cache = new Map<string, AliasMap | null>();

/** Tolerant JSONC parse — tsconfig files legally contain comments and trailing commas. */
function parseJsonc(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    try {
      const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/,(\s*[}\]])/g, '$1');
      return JSON.parse(stripped);
    } catch {
      return null;
    }
  }
}

/** Walk up from startDir to the nearest tsconfig.json/jsconfig.json with paths. */
export function loadPathAliases(startDir: string): AliasMap | null {
  const key = path.resolve(startDir);
  if (cache.has(key)) return cache.get(key)!;

  let dir = key;
  for (let i = 0; i < 12; i++) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const configPath = path.join(dir, name);
      if (!fs.existsSync(configPath)) continue;
      const cfg = parseJsonc(fs.readFileSync(configPath, 'utf-8'));
      const co = (cfg?.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> };
      if (!co.paths) continue;
      const baseDir = path.resolve(dir, co.baseUrl ?? '.');
      const aliases: AliasEntry[] = Object.entries(co.paths).map(([alias, targets]) => ({
        prefix: alias.replace(/\*$/, ''),
        targets: targets.map(t => path.resolve(baseDir, t.replace(/\*$/, ''))),
      }));
      const result = { configPath, aliases };
      cache.set(key, result);
      return result;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cache.set(key, null);
  return null;
}

/** Resolve an aliased import to absolute path candidates (no extension). Empty if no alias matches. */
export function resolveAliasedImport(importPath: string, aliasMap: AliasMap | null): string[] {
  if (!aliasMap) return [];
  const out: string[] = [];
  for (const { prefix, targets } of aliasMap.aliases) {
    if (!importPath.startsWith(prefix)) continue;
    const rest = importPath.slice(prefix.length);
    for (const target of targets) out.push(path.join(target, rest));
  }
  return out;
}

/** Test hook. */
export function clearAliasCache(): void {
  cache.clear();
}
