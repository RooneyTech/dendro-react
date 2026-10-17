// OXC must stay external: bundling its import.meta.url captures the build host's
// absolute path. Ship its original loader, the installed native binding, and a
// universal WASI fallback beside the bundles instead.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { createGunzip } = require('node:zlib');
const tar = require('tar-fs');

const root = path.resolve(__dirname, '..');

async function stageParserRuntime(outputPath = path.join(root, 'dist')) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const copied = new Set();
  const destination = path.join(outputPath, 'node_modules');
  fs.rmSync(destination, { recursive: true, force: true });

  async function stage(name) {
    if (copied.has(name)) return;
    copied.add(name);
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry?.integrity || !entry.resolved) throw new Error(`Missing locked parser runtime: ${name}`);
    let source = path.join(root, 'node_modules', name);
    const matches = (directory) => {
      try { return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version === entry.version; }
      catch { return false; }
    };
    // npm intentionally skips the cpu:wasm32 package on normal machines. Some
    // npm releases also skip its shared runtime dependencies. Use lock-pinned,
    // integrity-checked tarballs for those packages; npm reuses its local cache.
    if (!matches(source)) {
      source = path.join(root, 'node_modules', '.cache', 'dendro-parser-runtime', name, entry.version);
      const marker = path.join(source, '.dendro-integrity');
      if (!matches(source) || !fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== entry.integrity) {
        const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dendro-parser-'));
        try {
          const npmCli = process.env.npm_execpath;
          const command = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
          const args = [
            'pack', entry.resolved, '--ignore-scripts', '--json', '--pack-destination', temporary,
          ];
          if (npmCli) args.unshift(npmCli);
          const packed = JSON.parse(execFileSync(command, args, {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            shell: !npmCli && process.platform === 'win32',
          }));
          const archive = path.join(temporary, packed[0].filename);
          const [algorithm, expected] = entry.integrity.split('-');
          const actual = crypto.createHash(algorithm).update(fs.readFileSync(archive)).digest('base64');
          if (actual !== expected) throw new Error(`Parser runtime integrity mismatch: ${name}`);
          fs.rmSync(source, { recursive: true, force: true });
          fs.mkdirSync(source, { recursive: true });
          await pipeline(fs.createReadStream(archive), createGunzip(), tar.extract(source, {
            strip: 1,
          }));
          if (!matches(source)) throw new Error(`Parser runtime version mismatch: ${name}`);
          fs.writeFileSync(marker, entry.integrity);
        } finally {
          fs.rmSync(temporary, { recursive: true, force: true });
        }
      }
    }
    fs.cpSync(source, path.join(destination, name), {
      recursive: true,
      filter: (file) => !['node_modules', '.dendro-integrity'].includes(path.basename(file)),
    });
    for (const dependency of Object.keys(entry.dependencies || {})) await stage(dependency);
  }

  await stage('oxc-parser');
  await stage('@oxc-parser/binding-wasm32-wasi');
  const parser = lock.packages['node_modules/oxc-parser'];
  for (const name of Object.keys(parser.optionalDependencies || {})) {
    if (fs.existsSync(path.join(root, 'node_modules', name, 'package.json'))) await stage(name);
  }
  console.log(`Staged OXC ${parser.version}: ${copied.size} runtime packages in ${destination}`);
}

class ParserRuntimePlugin {
  apply(compiler) {
    compiler.hooks.afterEmit.tapPromise('ParserRuntimePlugin', () => stageParserRuntime(compiler.options.output.path));
  }
}

module.exports = { ParserRuntimePlugin, stageParserRuntime };
if (require.main === module) stageParserRuntime().catch((error) => { console.error(error); process.exitCode = 1; });
