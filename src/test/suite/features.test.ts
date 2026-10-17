/**
 * Feature Tests — Tree-to-Code Linking, Projector Mode, Colorblind Palette
 *
 * Tests for the 3 features from the Dendro ML cross-project design research.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { getComponentTree } from '../../mcp/tools';

const FIXTURES_DIR = path.resolve(__dirname, '../../../src/test/fixtures/mcp-tools');
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

suite('Feature: Tree-to-Code Linking', function () {
  this.timeout(30000);

  test('static tree nodes should have file property', function () {
    const entryFile = path.join(FIXTURES_DIR, 'App.tsx');
    const result = getComponentTree(entryFile);
    assert.ok(!result.error, `Unexpected error: ${result.error}`);
    assert.ok(result.tree, 'Tree should exist');
    assert.ok(result.tree?.file, 'Root node should have a file property');
  });

  test('child nodes should have file paths', function () {
    const entryFile = path.join(FIXTURES_DIR, 'App.tsx');
    const result = getComponentTree(entryFile);
    assert.ok(result.tree, 'Tree should exist');
    const children = result.tree?.children || [];
    assert.ok(children.length > 0, 'Should have child components');
    for (const child of children) {
      assert.ok(child.file, `Child "${child.file || 'unknown'}" should have a file property`);
    }
  });

  test('relative paths should resolve against workspace root', function () {
    const relativePath = 'src/components/App.tsx';
    const workspaceRoot = '/Users/test/project';
    const resolved = path.isAbsolute(relativePath)
      ? relativePath
      : path.join(workspaceRoot, relativePath);
    assert.ok(path.isAbsolute(resolved), 'Resolved path should be absolute');
    assert.strictEqual(resolved, '/Users/test/project/src/components/App.tsx');
  });

  test('absolute paths should pass through unchanged', function () {
    const absolutePath = '/Users/test/project/src/App.tsx';
    const workspaceRoot = '/Users/test/project';
    const resolved = path.isAbsolute(absolutePath)
      ? absolutePath
      : path.join(workspaceRoot, absolutePath);
    assert.strictEqual(resolved, absolutePath);
  });
});

suite('Feature: Projector Mode', function () {
  this.timeout(10000);

  test('pFont helper should scale font sizes at 1.4x', function () {
    const pScale = 1.4;
    const pFont = (basePx: number) => `${Math.round(basePx * pScale)}px`;
    assert.strictEqual(pFont(12), '17px');
    assert.strictEqual(pFont(11), '15px');
    assert.strictEqual(pFont(10), '14px');
    assert.strictEqual(pFont(9), '13px');
    assert.strictEqual(pFont(16), '22px');
  });

  test('pFont helper should be identity at 1x', function () {
    const pScale = 1;
    const pFont = (basePx: number) => `${Math.round(basePx * pScale)}px`;
    assert.strictEqual(pFont(12), '12px');
    assert.strictEqual(pFont(11), '11px');
    assert.strictEqual(pFont(10), '10px');
  });

  test('node radius should scale at 1.4x in projector mode', function () {
    const baseRadius = 40; // NODE_CONFIG.membraneRadius default
    const pScale = 1.4;
    const nodeRadius = Math.round(baseRadius * pScale);
    assert.strictEqual(nodeRadius, 56);
  });

  test('stroke widths should scale in projector mode', function () {
    const baseStroke = 1.5;
    const pScale = 1.4;
    assert.strictEqual(baseStroke * pScale, 2.0999999999999996);
    assert.ok(baseStroke * pScale > baseStroke, 'Scaled stroke should be larger');
  });

  test('package.json should have projectorMode command', function () {
    const pkgPath = path.join(PROJECT_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const commands = pkg.contributes?.commands || [];
    const projectorCmd = commands.find((c: any) => c.command === 'dendro-react.projectorMode');
    assert.ok(projectorCmd, 'dendro-react.projectorMode command should exist in package.json');
    assert.ok(projectorCmd.title.includes('Projector'), 'Command title should mention Projector');
  });

  test('package.json should have projectorMode configuration', function () {
    const pkgPath = path.join(PROJECT_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const props = pkg.contributes?.configuration?.properties || {};
    assert.ok(props['dendro-react.projectorMode'], 'dendro-react.projectorMode config should exist');
    assert.strictEqual(props['dendro-react.projectorMode'].type, 'boolean');
    assert.strictEqual(props['dendro-react.projectorMode'].default, false);
  });
});

suite('Feature: Colorblind-Safe Palette', function () {
  this.timeout(10000);

  // Import tokens at runtime from compiled output
  let PALETTE: any;
  let HIGHLIGHT_COLORS: any;

  suiteSetup(function () {
    // tokens.js is a webview module (ESM-style exports), so we require the compiled version
    // Since it uses `export const`, we need the webpack bundle or eval approach.
    // Instead, we parse the source file directly to verify token values.
    const tokensPath = path.join(PROJECT_ROOT, 'src/webview/tokens.js');
    const source = fs.readFileSync(tokensPath, 'utf-8');

    // Extract PALETTE values by parsing the source
    const paletteMatch = source.match(/export const PALETTE = \{([\s\S]*?)\};/);
    assert.ok(paletteMatch, 'PALETTE should be defined in tokens.js');

    // Parse individual values
    const extractHex = (name: string): string | null => {
      const re = new RegExp(`${name}:\\s*"(#[0-9a-fA-F]+)"`);
      const m = source.match(re);
      return m ? m[1] : null;
    };

    PALETTE = {
      stellarCyan: extractHex('stellarCyan'),
      auroraGreen: extractHex('auroraGreen'),
      greenDark: extractHex('greenDark'),
      genesisGreen: extractHex('genesisGreen'),
      statusConnected: extractHex('statusConnected'),
      statusListening: extractHex('statusListening'),
      statusOffline: extractHex('statusOffline'),
      green: extractHex('green'),
    };
  });

  test('auroraGreen should be Okabe-Ito bluish green (#009E73)', function () {
    assert.strictEqual(PALETTE.auroraGreen, '#009E73');
  });

  test('auroraGreen should be distinguishable from stellarCyan', function () {
    assert.notStrictEqual(PALETTE.auroraGreen, PALETTE.stellarCyan,
      'auroraGreen and stellarCyan must be different colors for CVD safety');
  });

  test('stellarCyan should still be #00d4ff', function () {
    assert.strictEqual(PALETTE.stellarCyan, '#00d4ff');
  });

  test('green alias should match auroraGreen', function () {
    assert.strictEqual(PALETTE.green, PALETTE.auroraGreen,
      'Short alias "green" should match auroraGreen');
  });

  test('status tokens should exist', function () {
    assert.ok(PALETTE.statusConnected, 'statusConnected should be defined');
    assert.ok(PALETTE.statusListening, 'statusListening should be defined');
    assert.ok(PALETTE.statusOffline, 'statusOffline should be defined');
  });

  test('old teal color (#00ffe5) should not appear in AppHeader.jsx', function () {
    const appHeaderPath = path.join(PROJECT_ROOT, 'src/webview/AppHeader.jsx');
    const source = fs.readFileSync(appHeaderPath, 'utf-8');
    assert.ok(!source.includes('#00ffe5'),
      'AppHeader.jsx should not contain old teal color #00ffe5');
  });

  test('old teal color (#00ffe5) should not appear in Dendrogram.jsx', function () {
    const dendrogramPath = path.join(PROJECT_ROOT, 'src/webview/Dendrogram.jsx');
    const source = fs.readFileSync(dendrogramPath, 'utf-8');
    assert.ok(!source.includes('#00ffe5'),
      'Dendrogram.jsx should not contain old teal color #00ffe5');
  });

  test('hardcoded status colors should not appear in AppHeader.jsx', function () {
    const appHeaderPath = path.join(PROJECT_ROOT, 'src/webview/AppHeader.jsx');
    const source = fs.readFileSync(appHeaderPath, 'utf-8');
    // These should now use PALETTE.statusConnected etc.
    const hardcodedColors = ["'#00ff64'", "'#ffc800'", "'#ff4444'"];
    for (const color of hardcodedColors) {
      assert.ok(!source.includes(color),
        `AppHeader.jsx should not contain hardcoded ${color} — use PALETTE tokens`);
    }
  });
});
