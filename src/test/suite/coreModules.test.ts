/**
 * Unit Tests for Core Modules
 *
 * Tests the new Stage 2 implementations:
 * - Cache module (2-tier LRU cache)
 * - Hook dependency analysis
 * - Prop flow analysis
 */

import * as assert from 'assert';
import * as path from 'path';
import { ParseCache, hashContent, makeCacheKey, PARSER_VERSION } from '../../core/cache';
import { analyzeHookDependencies, HookAnalysisResult } from '../../core/hook-deps';
import { tracePropFlow, PropFlowResult } from '../../core/prop-flow';

// Fixtures directory
const projectRoot = process.cwd();
const hooksFixturesDir = path.join(projectRoot, 'src/test/fixtures/hooks');
const propFlowFixturesDir = path.join(projectRoot, 'src/test/fixtures/prop-flow');

suite('Core Modules', function () {

  suite('Cache Module', function () {
    test('should create a ParseCache instance', function () {
      const cache = new ParseCache();
      assert.ok(cache, 'Cache should be created');
    });

    test('should hash content consistently', function () {
      const content = 'const x = 1;';
      const hash1 = hashContent(content);
      const hash2 = hashContent(content);
      assert.strictEqual(hash1, hash2, 'Same content should produce same hash');
    });

    test('should generate different hashes for different content', function () {
      const hash1 = hashContent('const x = 1;');
      const hash2 = hashContent('const x = 2;');
      assert.notStrictEqual(hash1, hash2, 'Different content should produce different hash');
    });

    test('should make cache keys with parser version', function () {
      const key = makeCacheKey('/path/to/file.tsx', 'abc123');
      assert.ok(key.includes('/path/to/file.tsx'), 'Key should include file path');
      assert.ok(key.includes('abc123'), 'Key should include content hash');
      assert.ok(key.includes(PARSER_VERSION), 'Key should include parser version');
    });

    test('should return null for uncached files', function () {
      const cache = new ParseCache();
      const result = cache.get('/nonexistent/file.tsx', 'content');
      assert.strictEqual(result, null, 'Should return null for uncached file');
    });

    test('should track cache statistics', function () {
      const cache = new ParseCache();
      const stats = cache.getStats();
      assert.strictEqual(stats.hits, 0, 'Initial hits should be 0');
      assert.strictEqual(stats.misses, 0, 'Initial misses should be 0');
    });

    test('should update hit ratio', function () {
      const cache = new ParseCache();
      // Generate a miss
      cache.get('/file.tsx', 'content');
      const ratio = cache.getHitRatio();
      assert.strictEqual(ratio, 0, 'Hit ratio should be 0 after only misses');
    });
  });

  suite('Hook Dependency Analysis', function () {
    test('should analyze hooks in a component', function () {
      const filePath = path.join(hooksFixturesDir, 'HooksComponent.tsx');
      const result: HookAnalysisResult = analyzeHookDependencies(filePath);

      assert.ok(!result.error, `Should not have error: ${result.error}`);
      assert.strictEqual(result.file, 'HooksComponent.tsx');
      assert.strictEqual(result.component, 'HooksComponent');
    });

    test('should detect useState hooks', function () {
      const filePath = path.join(hooksFixturesDir, 'HooksComponent.tsx');
      const result = analyzeHookDependencies(filePath);

      assert.ok(result.stateVariables.includes('count'), 'Should detect count state');
      assert.ok(result.stateVariables.includes('name'), 'Should detect name state');
    });

    test('should detect useRef hooks', function () {
      const filePath = path.join(hooksFixturesDir, 'HooksComponent.tsx');
      const result = analyzeHookDependencies(filePath);

      assert.ok(result.refVariables.includes('inputRef'), 'Should detect inputRef');
    });

    test('should detect useContext hooks', function () {
      const filePath = path.join(hooksFixturesDir, 'HooksComponent.tsx');
      const result = analyzeHookDependencies(filePath);

      assert.ok(result.contextUsages.includes('ThemeContext'), 'Should detect ThemeContext usage');
    });

    test('should detect useEffect hooks', function () {
      const filePath = path.join(hooksFixturesDir, 'HooksComponent.tsx');
      const result = analyzeHookDependencies(filePath);

      const effects = result.hooks.filter(h => h.hookType === 'useEffect');
      assert.ok(effects.length >= 3, `Should have at least 3 useEffect hooks, got ${effects.length}`);
    });

    test('should detect empty dependency arrays', function () {
      const filePath = path.join(hooksFixturesDir, 'HooksComponent.tsx');
      const result = analyzeHookDependencies(filePath);

      const emptyDepsEffects = result.hooks.filter(h => h.hasEmptyDeps);
      assert.ok(emptyDepsEffects.length >= 1, 'Should have at least 1 effect with empty deps');
    });

    test('should detect missing dependency arrays', function () {
      const filePath = path.join(hooksFixturesDir, 'HooksComponent.tsx');
      const result = analyzeHookDependencies(filePath);

      const noDepEffects = result.hooks.filter(h => h.hasNoDeps);
      assert.ok(noDepEffects.length >= 1, 'Should have at least 1 effect with no deps array');
    });

    test('should detect useMemo hooks', function () {
      const filePath = path.join(hooksFixturesDir, 'HooksComponent.tsx');
      const result = analyzeHookDependencies(filePath);

      const memos = result.hooks.filter(h => h.hookType === 'useMemo');
      assert.ok(memos.length >= 1, 'Should have at least 1 useMemo hook');
    });

    test('should detect useCallback hooks', function () {
      const filePath = path.join(hooksFixturesDir, 'HooksComponent.tsx');
      const result = analyzeHookDependencies(filePath);

      const callbacks = result.hooks.filter(h => h.hookType === 'useCallback');
      assert.ok(callbacks.length >= 1, 'Should have at least 1 useCallback hook');
    });

    test('should return error for non-existent file', function () {
      const result = analyzeHookDependencies('/nonexistent/file.tsx');
      assert.ok(result.error, 'Should have error for non-existent file');
    });

    test('should detect destructured props', function () {
      const filePath = path.join(hooksFixturesDir, 'HooksComponent.tsx');
      const result = analyzeHookDependencies(filePath);

      assert.ok(result.propDestructures.includes('initialCount'), 'Should detect initialCount prop');
      assert.ok(result.propDestructures.includes('onCountChange'), 'Should detect onCountChange prop');
    });
  });

  suite('Prop Flow Analysis', function () {
    test('should trace props through components', function () {
      const filePath = path.join(propFlowFixturesDir, 'Parent.tsx');
      const result: PropFlowResult = tracePropFlow(filePath, 'userId');

      assert.ok(!result.error, `Should not have error: ${result.error}`);
      assert.strictEqual(result.sourceProp, 'userId');
      assert.strictEqual(result.sourceComponent, 'Parent');
    });

    test('should return error for non-existent file', function () {
      const result = tracePropFlow('/nonexistent/file.tsx', 'prop');
      assert.ok(result.error, 'Should have error for non-existent file');
      assert.ok(result.boundaries.length > 0, 'Should have boundary for non-existent file');
    });

    test('should track total components traced', function () {
      const filePath = path.join(propFlowFixturesDir, 'Parent.tsx');
      const result = tracePropFlow(filePath, 'userId');

      assert.ok(result.totalComponentsTraced >= 1, 'Should trace at least 1 component');
    });

    test('should detect component name from file', function () {
      const filePath = path.join(propFlowFixturesDir, 'Parent.tsx');
      const result = tracePropFlow(filePath, 'userId');

      assert.strictEqual(result.sourceComponent, 'Parent');
    });
  });

});
