// Build script: bundles TypeScript with esbuild and copies static assets into dist/.
//
//   node build.mjs             production build
//   node build.mjs --watch     rebuild on change
//   node build.mjs --no-model  leave the bundled translation model out (smaller package)
//   node build.mjs --zip       also write release/mitlesen-<version>[-lite].zip
import { build, context } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const withModel = !args.has('--no-model');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const common = {
  bundle: true,
  target: ['chrome116'],
  platform: 'browser',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  legalComments: 'none',
  logLevel: 'info',
  define: { __VERSION__: JSON.stringify(pkg.version), __DEV__: JSON.stringify(watch) },
};

/** @type {import('esbuild').BuildOptions[]} */
const targets = [
  { ...common, entryPoints: { background: 'src/background/index.ts' }, outdir: dist, format: 'esm' },
  { ...common, entryPoints: { content: 'src/content/index.ts' }, outdir: dist, format: 'iife' },
  { ...common, entryPoints: { 'youtube-main': 'src/inject/youtube-main.ts' }, outdir: dist, format: 'iife' },
  { ...common, entryPoints: { popup: 'src/ui/popup.ts' }, outdir: dist, format: 'iife' },
  { ...common, entryPoints: { offscreen: 'src/offscreen/offscreen.ts' }, outdir: dist, format: 'iife' },
  // The model worker pulls in transformers.js; it stays an ES module so onnxruntime can import its glue code.
  { ...common, entryPoints: { 'mt.worker': 'src/offscreen/mt.worker.ts' }, outdir: dist, format: 'esm', minify: false },
];

function copyStatic() {
  mkdirSync(dist, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(root, 'src', 'manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));

  for (const [from, to] of [
    ['src/ui/popup.html', 'popup.html'],
    ['src/ui/popup.css', 'popup.css'],
    ['src/offscreen/offscreen.html', 'offscreen.html'],
    ['assets/icons', 'icons'],
    ['data/dict', 'dict'],
    ['_locales', '_locales'],
    // The model (CC BY 4.0) and the dictionary (CC BY-SA 4.0) travel with their attribution.
    ['LICENSE', 'LICENSE.txt'],
    ['LICENSES_AND_ATTRIBUTION.md', 'LICENSES_AND_ATTRIBUTION.md'],
  ]) {
    const src = join(root, from);
    if (existsSync(src)) cpSync(src, join(dist, to), { recursive: true });
  }

  // onnxruntime-web runtime files must be local: Manifest V3 forbids remotely hosted code.
  const ortDir = join(root, 'node_modules', 'onnxruntime-web', 'dist');
  mkdirSync(join(dist, 'ort'), { recursive: true });
  for (const f of readdirSync(ortDir)) {
    // transformers.js 4.x loads the "asyncify" build of the runtime.
    if (/^ort-wasm-simd-threaded\.asyncify\.(mjs|wasm)$/.test(f)) cpSync(join(ortDir, f), join(dist, 'ort', f));
  }

  const models = join(root, 'models', 'browser');
  if (withModel && existsSync(models)) {
    cpSync(models, join(dist, 'models'), { recursive: true });
  } else {
    rmSync(join(dist, 'models'), { recursive: true, force: true });
  }
}

function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

function zip() {
  const outDir = join(root, 'release');
  mkdirSync(outDir, { recursive: true });
  const hasModel = existsSync(join(dist, 'models'));
  const out = join(outDir, `mitlesen-${pkg.version}${hasModel ? '' : '-lite'}.zip`);
  rmSync(out, { force: true });
  // bsdtar ships with Windows 10+ and writes zip archives with -a.
  execFileSync('tar.exe', ['-a', '-c', '-f', out, '-C', dist, '.'], { stdio: 'inherit' });
  console.log(`zip: ${out} (${(statSync(out).size / 1048576).toFixed(1)} MB)`);
}

if (watch) {
  copyStatic();
  const ctxs = await Promise.all(targets.map((t) => context(t)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('watching…');
} else {
  rmSync(dist, { recursive: true, force: true });
  await Promise.all(targets.map((t) => build(t)));
  copyStatic();
  console.log(`dist: ${(dirSize(dist) / 1048576).toFixed(1)} MB${existsSync(join(dist, 'models')) ? ' (with bundled model)' : ' (no bundled model)'}`);
  if (args.has('--zip')) zip();
}
