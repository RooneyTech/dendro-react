/**
 * Unit Tests for CTX-PACK v0.1 (TICKET-061)
 *
 * buildContextPack is pure filesystem + git; tests run it against a fixture
 * tree written into a temp directory (no git → exercises the honest-degrade
 * path) and against this repo's own src/ (git available).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildContextPack, CTX_PACK_VERSION } from '../../mcp/context-pack';

suite('CTX-PACK (context-pack)', function () {
  let tmpDir: string;

  suiteSetup(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxpack-'));
    fs.mkdirSync(path.join(tmpDir, 'core'));
    fs.mkdirSync(path.join(tmpDir, 'ui'));
    fs.writeFileSync(path.join(tmpDir, 'index.ts'), `import { a } from './core/a';\nimport { B } from './ui/b';\nexport {};\n`);
    fs.writeFileSync(path.join(tmpDir, 'core', 'a.ts'), `export const a = 1;\n${'// pad\n'.repeat(50)}`);
    fs.writeFileSync(path.join(tmpDir, 'ui', 'b.tsx'), `import { a } from '../core/a';\nexport const B = () => null;\n`);
  });

  suiteTeardown(function () {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('emits a well-formed pack: header, schema comments, END', function () {
    const { pack } = buildContextPack(tmpDir);
    const lines = pack.split('\n');
    assert.ok(lines[0].startsWith(`CTX-PACK/${CTX_PACK_VERSION} `), 'first line is versioned header');
    assert.ok(/scope=/.test(lines[0]) && /asof=\d{4}-\d{2}-\d{2}/.test(lines[0]), 'header has scope and asof');
    assert.ok(lines.some(l => l.startsWith('# D <dir>')), 'schema comment for D rows');
    assert.strictEqual(lines[lines.length - 1], 'END', 'pack terminates with END');
  });

  test('D rows roll up top-level dirs; root files fold into "."', function () {
    const { pack, stats } = buildContextPack(tmpDir);
    const dRows = pack.split('\n').filter(l => l.startsWith('D '));
    const dirNames = dRows.map(l => l.split(' ')[1]).sort();
    assert.deepStrictEqual(dirNames, ['.', 'core', 'ui'], 'one D row per top-level dir plus root');
    const coreRow = dRows.find(l => l.startsWith('D core'))!.split(' ');
    assert.strictEqual(Number(coreRow[2]), 1, 'core has 1 file');
    assert.strictEqual(Number(coreRow[3]), 51, 'core loc counted');
    assert.strictEqual(stats.files, 3);
  });

  test('E rows capture cross-directory imports with counts', function () {
    const { pack } = buildContextPack(tmpDir);
    const eRows = pack.split('\n').filter(l => l.startsWith('E '));
    assert.ok(eRows.includes('E ui core 1'), `ui→core edge present (got: ${eRows.join(' | ')})`);
    assert.ok(eRows.includes('E . core 1') && eRows.includes('E . ui 1'), 'root index edges present');
  });

  test('X rows flag entry-point candidates', function () {
    const { pack } = buildContextPack(tmpDir);
    assert.ok(pack.split('\n').includes('X index.ts entry'), 'root index.ts is an entry candidate');
  });

  test('degrades honestly without git: zeros + warning + comment', function () {
    const { pack, stats, warnings } = buildContextPack(tmpDir);
    // tmpdir is outside any repo on CI; if a parent repo exists, skip the strict half
    if (!stats.gitAvailable) {
      assert.ok(warnings.some(w => w.includes('git unavailable')), 'warning present');
      assert.ok(pack.includes('# git: unavailable'), 'comment present in pack');
      assert.ok(pack.split('\n').filter(l => l.startsWith('D ')).every(l => l.endsWith(' 0')), 'hot columns are 0');
    }
  });

  test('packs this repo\'s src/ within the token budget', function () {
    const src = path.join(process.cwd(), 'src');
    const { pack, stats } = buildContextPack(src);
    assert.ok(stats.files > 50, 'scanned a real tree');
    assert.ok(stats.approxTokens < 700, `approxTokens ${stats.approxTokens} stays small`);
    assert.ok(pack.split('\n').some(l => l.startsWith('F mcp/tools.ts')), 'largest file surfaces as F row');
  });

  test('topFiles caps F rows but hot files always survive', function () {
    const src = path.join(process.cwd(), 'src');
    const { pack } = buildContextPack(src, 1);
    const fRows = pack.split('\n').filter(l => l.startsWith('F '));
    assert.ok(fRows.length >= 1, 'at least the top file');
    for (const row of fRows.slice(1)) {
      const hot = Number(row.split(' ')[3]);
      assert.ok(hot >= 3, `extra F row beyond topFiles=1 must be hot (row: ${row})`);
    }
  });
});
