/**
 * Unit Tests for OXC Parser Module
 *
 * Tests the parser-oxc.ts implementation to ensure:
 * - Correct AST parsing with OXC
 * - Component type detection (functional/class)
 * - useState hook detection
 * - Import/export analysis
 * - Module resolution
 * - Component tree building
 */

import * as assert from 'assert';
import * as path from 'path';
import {
  parseFileToAST,
  findComponentTypeAndState,
  findImportsInAST,
  findReExportsInAST,
  resolveImportPath,
  resolveBarrelExports,
  isIndexFile,
  buildComponentTree,
  EXTENSIONS,
  INDEX_FILES
} from '../../server/parser-oxc';

// Fixtures are in src/test/fixtures but tests run from out/test/suite
// Use process.cwd() to get project root
const projectRoot = process.cwd();
const fixturesDir = path.join(projectRoot, 'src/test/fixtures/mcp-tools');
const barrelFixturesDir = path.join(projectRoot, 'src/test/fixtures/barrel-exports');

suite('OXC Parser Module', () => {

  suite('parseFileToAST', () => {
    test('should return ParseResult for valid file', () => {
      const result = parseFileToAST(path.join(fixturesDir, 'App.tsx'));
      assert.notStrictEqual(result, null);
      assert.ok(result?.program, 'Should have program');
      assert.ok(result?.module, 'Should have module');
    });

    test('should return null for non-existent file', () => {
      const result = parseFileToAST('/non/existent/file.tsx');
      assert.strictEqual(result, null);
    });

    test('should parse TypeScript files', () => {
      const result = parseFileToAST(path.join(fixturesDir, 'Header.tsx'));
      assert.notStrictEqual(result, null);
      const body = result?.program?.body as unknown[];
      assert.ok(body && body.length > 0);
    });
  });

  suite('findComponentTypeAndState', () => {
    test('should detect functional component', () => {
      const result = parseFileToAST(path.join(fixturesDir, 'App.tsx'));
      const { type } = findComponentTypeAndState(result);
      assert.strictEqual(type, 'functional');
    });

    test('should detect useState hooks', () => {
      const result = parseFileToAST(path.join(fixturesDir, 'Header.tsx'));
      const { stateVariables } = findComponentTypeAndState(result);
      assert.ok(stateVariables.includes('menuOpen'), 'Should detect menuOpen state');
    });

    test('should detect multiple useState hooks', () => {
      const result = parseFileToAST(path.join(fixturesDir, 'MainContent.tsx'));
      const { stateVariables } = findComponentTypeAndState(result);
      assert.ok(stateVariables.includes('data'), 'Should detect data state');
      assert.ok(stateVariables.includes('loading'), 'Should detect loading state');
    });

    test('should handle null input gracefully', () => {
      const { type, stateVariables } = findComponentTypeAndState(null);
      assert.strictEqual(type, null);
      assert.deepStrictEqual(stateVariables, []);
    });

    test('should return empty state for components without hooks', () => {
      const result = parseFileToAST(path.join(fixturesDir, 'Footer.tsx'));
      const { stateVariables } = findComponentTypeAndState(result);
      assert.deepStrictEqual(stateVariables, []);
    });
  });

  suite('findImportsInAST', () => {
    test('should extract local imports', () => {
      const result = parseFileToAST(path.join(fixturesDir, 'App.tsx'));
      const imports = findImportsInAST(result);
      assert.ok(imports.length > 0, 'Should find imports');
    });

    test('should filter out external packages', () => {
      const result = parseFileToAST(path.join(fixturesDir, 'App.tsx'));
      const imports = findImportsInAST(result);
      // Should not include 'react' or other npm packages
      assert.ok(!imports.includes('react'), 'Should not include react');
      // Should only include relative imports
      assert.ok(imports.every(i => i.startsWith('.') || i.startsWith('/')));
    });

    test('should handle null input gracefully', () => {
      const imports = findImportsInAST(null);
      assert.deepStrictEqual(imports, []);
    });
  });

  suite('findReExportsInAST', () => {
    test('should find named re-exports', () => {
      const indexPath = path.join(barrelFixturesDir, 'components/index.ts');
      const result = parseFileToAST(indexPath);
      const reExports = findReExportsInAST(result);
      assert.ok(reExports.length > 0, 'Should find re-exports');
    });

    test('should handle null input gracefully', () => {
      const reExports = findReExportsInAST(null);
      assert.deepStrictEqual(reExports, []);
    });
  });

  suite('resolveImportPath', () => {
    test('should resolve import with extension', () => {
      const resolved = resolveImportPath('./Header', fixturesDir);
      assert.notStrictEqual(resolved, null);
      assert.ok(resolved?.endsWith('Header.tsx'));
    });

    test('should resolve import without extension', () => {
      const resolved = resolveImportPath('./Footer', fixturesDir);
      assert.notStrictEqual(resolved, null);
    });

    test('should return null for non-existent import', () => {
      const resolved = resolveImportPath('./NonExistent', fixturesDir);
      assert.strictEqual(resolved, null);
    });

    test('should resolve directory imports to index files', () => {
      const resolved = resolveImportPath('./components', barrelFixturesDir);
      assert.notStrictEqual(resolved, null);
      assert.ok(resolved?.includes('index'));
    });
  });

  suite('isIndexFile', () => {
    test('should return true for index.ts', () => {
      assert.strictEqual(isIndexFile('/path/to/index.ts'), true);
    });

    test('should return true for index.tsx', () => {
      assert.strictEqual(isIndexFile('/path/to/index.tsx'), true);
    });

    test('should return true for index.js', () => {
      assert.strictEqual(isIndexFile('/path/to/index.js'), true);
    });

    test('should return true for index.jsx', () => {
      assert.strictEqual(isIndexFile('/path/to/index.jsx'), true);
    });

    test('should return false for regular components', () => {
      assert.strictEqual(isIndexFile('/path/to/Component.tsx'), false);
    });

    test('should return false for files containing index in name', () => {
      assert.strictEqual(isIndexFile('/path/to/index-backup.ts'), false);
    });
  });

  suite('resolveBarrelExports', () => {
    test('should resolve exports from barrel file', () => {
      const indexPath = path.join(barrelFixturesDir, 'components/index.ts');
      const exports = resolveBarrelExports(indexPath);
      assert.ok(exports.length > 0, 'Should find exported components');
    });

    test('should handle circular references', () => {
      const indexPath = path.join(barrelFixturesDir, 'components/index.ts');
      const visited = new Set<string>();
      visited.add(indexPath);
      const exports = resolveBarrelExports(indexPath, visited);
      assert.deepStrictEqual(exports, [], 'Should return empty for already visited');
    });
  });

  suite('buildComponentTree', () => {
    test('should return tree structure for valid entry', () => {
      const tree = buildComponentTree('App.tsx', fixturesDir);
      assert.notStrictEqual(tree, null);
      assert.strictEqual(tree?.file, 'App.tsx');
      assert.ok(Array.isArray(tree?.children));
    });

    test('should include component type', () => {
      const tree = buildComponentTree('App.tsx', fixturesDir);
      assert.strictEqual(tree?.type, 'functional');
    });

    test('should include state array', () => {
      const tree = buildComponentTree('App.tsx', fixturesDir);
      assert.ok(Array.isArray(tree?.state));
    });

    test('should build nested component tree', () => {
      const tree = buildComponentTree('App.tsx', fixturesDir);
      assert.ok(tree!.children.length > 0, 'Should have children');

      const header = tree!.children.find(c => c.file === 'Header.tsx');
      assert.ok(header, 'Should include Header');
      assert.ok(header!.children.length > 0, 'Header should have children');
    });

    test('should detect state in child components', () => {
      const tree = buildComponentTree('App.tsx', fixturesDir);
      const header = tree!.children.find(c => c.file === 'Header.tsx');
      assert.ok(header!.state.includes('menuOpen'));
    });

    test('should return null for non-existent file', () => {
      const tree = buildComponentTree('NonExistent.tsx', fixturesDir);
      assert.strictEqual(tree, null);
    });

    test('should handle barrel exports', () => {
      const tree = buildComponentTree('App.tsx', barrelFixturesDir);
      assert.notStrictEqual(tree, null);
      assert.ok(tree!.children.length > 0);
    });
  });

  suite('Constants', () => {
    test('EXTENSIONS should include all supported extensions', () => {
      assert.ok(EXTENSIONS.includes('.tsx'));
      assert.ok(EXTENSIONS.includes('.ts'));
      assert.ok(EXTENSIONS.includes('.jsx'));
      assert.ok(EXTENSIONS.includes('.js'));
      assert.strictEqual(EXTENSIONS.length, 4);
    });

    test('INDEX_FILES should match EXTENSIONS count', () => {
      assert.strictEqual(INDEX_FILES.length, EXTENSIONS.length);
    });

    test('INDEX_FILES should include index variants', () => {
      assert.ok(INDEX_FILES.includes('index.tsx'));
      assert.ok(INDEX_FILES.includes('index.ts'));
      assert.ok(INDEX_FILES.includes('index.jsx'));
      assert.ok(INDEX_FILES.includes('index.js'));
    });
  });

});
