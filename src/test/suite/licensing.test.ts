import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHmac, randomBytes } from 'crypto';
import {
  isProFeature,
  getFeatureTier,
  getProFeatureList,
  getFreeFeatureList
} from '../../licensing/feature-gate';
import { isProLicensed } from '../../licensing/license-file';

const LICENSE_FILE_DIR = path.join(os.homedir(), '.dendro');
const LICENSE_FILE_PATH = path.join(LICENSE_FILE_DIR, 'license-status.json');
const LICENSE_SECRET_PATH = path.join(LICENSE_FILE_DIR, '.license-secret');

function createSignedLicenseFile(isPro: boolean, cachedUntil: number, secret: string): string {
  const signature = createHmac('sha256', secret)
    .update(`${isPro}:${cachedUntil}`)
    .digest('hex');
  return JSON.stringify({ isPro, cachedUntil, signature });
}

suite('Licensing Test Suite', function () {
  this.timeout(10000);

  let originalFileContent: string | null = null;
  let originalSecretContent: string | null = null;

  suiteSetup(function () {
    try {
      originalFileContent = fs.readFileSync(LICENSE_FILE_PATH, 'utf-8');
    } catch {
      originalFileContent = null;
    }
    try {
      originalSecretContent = fs.readFileSync(LICENSE_SECRET_PATH, 'utf-8');
    } catch {
      originalSecretContent = null;
    }
  });

  suiteTeardown(function () {
    if (originalFileContent !== null) {
      fs.mkdirSync(LICENSE_FILE_DIR, { recursive: true });
      fs.writeFileSync(LICENSE_FILE_PATH, originalFileContent, 'utf-8');
    } else {
      try { fs.unlinkSync(LICENSE_FILE_PATH); } catch { /* ok */ }
    }
    if (originalSecretContent !== null) {
      fs.writeFileSync(LICENSE_SECRET_PATH, originalSecretContent, 'utf-8');
    } else {
      try { fs.unlinkSync(LICENSE_SECRET_PATH); } catch { /* ok */ }
    }
  });

  // ===========================================
  // Feature Gate Tests
  // ===========================================
  suite('FeatureGate', function () {

    test('all analysis tools should be free', function () {
      const freeAnalysis = [
        'get_component_tree', 'get_component_details', 'get_component_contract',
        'detect_circular_deps', 'get_used_by',
        'get_prop_flow', 'get_hook_deps', 'get_navigation_structure',
        'get_context_map', 'get_screen_components', 'get_complexity_report'
      ];
      for (const tool of freeAnalysis) {
        assert.strictEqual(isProFeature(tool), false, `${tool} should be free`);
        assert.strictEqual(getFeatureTier(tool), 'free', `${tool} tier should be 'free'`);
      }
    });

    test('all visualization tools should be free', function () {
      const freeViz = ['open_visualizer', 'visualize_batch', 'visualize_analysis'];
      for (const tool of freeViz) {
        assert.strictEqual(isProFeature(tool), false, `${tool} should be free`);
      }
    });

    test('export tool should be pro', function () {
      assert.strictEqual(isProFeature('export_analysis'), true, 'export_analysis should be pro');
      assert.strictEqual(getFeatureTier('export_analysis'), 'pro', "export_analysis tier should be 'pro'");
    });

    test('unknown tools should default to free', function () {
      assert.strictEqual(isProFeature('nonexistent_tool'), false);
      assert.strictEqual(getFeatureTier('nonexistent_tool'), 'free');
    });

    test('getProFeatureList should return all pro features', function () {
      const proList = getProFeatureList();
      assert.ok(proList.includes('export_analysis'), 'Should include export_analysis');
      assert.ok(proList.includes('manage_snapshots'), 'Should include manage_snapshots');
      assert.ok(proList.includes('verify_state_flows'), 'Should include verify_state_flows');
      assert.strictEqual(proList.length, 10, 'Should have exactly 10 pro features');
    });

    test('getFreeFeatureList should return all free features', function () {
      const freeList = getFreeFeatureList();
      assert.ok(freeList.includes('get_component_tree'), 'Should include get_component_tree');
      assert.ok(freeList.includes('visualize_batch'), 'Should include visualize_batch');
      assert.strictEqual(freeList.length, 24, 'Should have exactly 24 free features');
    });

    test('pro and free lists should not overlap', function () {
      const proList = getProFeatureList();
      const freeList = getFreeFeatureList();
      for (const tool of proList) {
        assert.ok(!freeList.includes(tool), `${tool} should not be in both lists`);
      }
    });
  });

  // ===========================================
  // License File Reader Tests (HMAC-verified)
  // ===========================================
  suite('isProLicensed', function () {
    const testSecret = randomBytes(32).toString('hex');

    function writeTestSecret(secret: string = testSecret): void {
      fs.mkdirSync(LICENSE_FILE_DIR, { recursive: true });
      fs.writeFileSync(LICENSE_SECRET_PATH, secret, 'utf-8');
    }

    function cleanupFiles(): void {
      try { fs.unlinkSync(LICENSE_FILE_PATH); } catch { /* ok */ }
      try { fs.unlinkSync(LICENSE_SECRET_PATH); } catch { /* ok */ }
    }

    test('should return false when no license file exists', function () {
      cleanupFiles();
      assert.strictEqual(isProLicensed(), false);
    });

    test('should return false when no secret file exists', function () {
      cleanupFiles();
      fs.mkdirSync(LICENSE_FILE_DIR, { recursive: true });
      fs.writeFileSync(LICENSE_FILE_PATH, JSON.stringify({
        isPro: true,
        cachedUntil: Date.now() + 86400000,
        signature: 'doesnotmatter'
      }), 'utf-8');
      assert.strictEqual(isProLicensed(), false);
    });

    test('should return false for malformed JSON', function () {
      writeTestSecret();
      fs.writeFileSync(LICENSE_FILE_PATH, 'not json at all', 'utf-8');
      assert.strictEqual(isProLicensed(), false);
    });

    test('should return false when isPro is false', function () {
      writeTestSecret();
      const content = createSignedLicenseFile(false, Date.now() + 86400000, testSecret);
      fs.writeFileSync(LICENSE_FILE_PATH, content, 'utf-8');
      assert.strictEqual(isProLicensed(), false);
    });

    test('should return false when cache is expired', function () {
      writeTestSecret();
      const content = createSignedLicenseFile(true, Date.now() - 1000, testSecret);
      fs.writeFileSync(LICENSE_FILE_PATH, content, 'utf-8');
      assert.strictEqual(isProLicensed(), false);
    });

    test('should return true when isPro, cache valid, and signature valid', function () {
      writeTestSecret();
      const content = createSignedLicenseFile(true, Date.now() + 86400000, testSecret);
      fs.writeFileSync(LICENSE_FILE_PATH, content, 'utf-8');
      assert.strictEqual(isProLicensed(), true);
    });

    test('should return false for empty object', function () {
      writeTestSecret();
      fs.writeFileSync(LICENSE_FILE_PATH, '{}', 'utf-8');
      assert.strictEqual(isProLicensed(), false);
    });

    test('should return false when signature is missing', function () {
      writeTestSecret();
      fs.writeFileSync(LICENSE_FILE_PATH, JSON.stringify({
        isPro: true,
        cachedUntil: Date.now() + 86400000
      }), 'utf-8');
      assert.strictEqual(isProLicensed(), false);
    });

    test('should return false when signature is wrong', function () {
      writeTestSecret();
      fs.writeFileSync(LICENSE_FILE_PATH, JSON.stringify({
        isPro: true,
        cachedUntil: Date.now() + 86400000,
        signature: 'deadbeef'.repeat(8)
      }), 'utf-8');
      assert.strictEqual(isProLicensed(), false);
    });

    test('should return false when secret file has wrong length', function () {
      fs.mkdirSync(LICENSE_FILE_DIR, { recursive: true });
      fs.writeFileSync(LICENSE_SECRET_PATH, 'tooshort', 'utf-8');
      const content = createSignedLicenseFile(true, Date.now() + 86400000, 'tooshort');
      fs.writeFileSync(LICENSE_FILE_PATH, content, 'utf-8');
      assert.strictEqual(isProLicensed(), false);
    });

    test('should return false when signed with different secret', function () {
      writeTestSecret();
      const differentSecret = randomBytes(32).toString('hex');
      const content = createSignedLicenseFile(true, Date.now() + 86400000, differentSecret);
      fs.writeFileSync(LICENSE_FILE_PATH, content, 'utf-8');
      assert.strictEqual(isProLicensed(), false);
    });

    test('should return false for trivial bypass (no secret file)', function () {
      cleanupFiles();
      fs.mkdirSync(LICENSE_FILE_DIR, { recursive: true });
      fs.writeFileSync(LICENSE_FILE_PATH, JSON.stringify({
        isPro: true,
        cachedUntil: 99999999999999
      }), 'utf-8');
      assert.strictEqual(isProLicensed(), false);
    });
  });
});
