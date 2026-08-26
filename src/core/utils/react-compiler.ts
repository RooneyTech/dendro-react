/**
 * React Compiler detection for the analyzed project.
 *
 * When babel-plugin-react-compiler (or its runtime) is present, the compiler
 * auto-memoizes components — manual useCallback/useMemo advice is not just
 * unnecessary but the opposite of current React guidance. Analyses that
 * recommend memoization should downgrade those findings when this returns true.
 */
import * as fs from 'fs';
import * as path from 'path';

const COMPILER_PACKAGES = [
  'babel-plugin-react-compiler',
  'react-compiler-runtime',
  'eslint-plugin-react-compiler',
];

const cache = new Map<string, boolean>();

/** Walk up from startDir looking for a package.json that declares the React Compiler. */
export function detectReactCompiler(startDir: string): boolean {
  let dir = path.resolve(startDir);
  if (fs.existsSync(dir) && fs.statSync(dir).isFile()) dir = path.dirname(dir);
  if (cache.has(dir)) return cache.get(dir)!;

  const origin = dir;
  for (let i = 0; i < 12; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        const found = COMPILER_PACKAGES.some(p => p in deps);
        cache.set(origin, found);
        return found;
      } catch {
        // unreadable package.json — keep walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cache.set(origin, false);
  return false;
}

/** Test hook: clear the per-directory detection cache. */
export function clearReactCompilerCache(): void {
  cache.clear();
}
