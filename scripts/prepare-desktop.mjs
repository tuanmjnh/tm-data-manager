#!/usr/bin/env node
/**
 * Assembles everything the desktop shell ships (roadmap Phase 8 packaging):
 *
 *   src-tauri/runtime/node[.exe]       Node runtime (MIT) so the app needs no system install
 *   src-tauri/runtime/udmt-core.cjs    CLI + API bundled into one CommonJS file
 *   src-tauri/runtime/ui/              static Nuxt build served by the core
 *
 * The Node binary is copied from the machine doing the build, so this must run on
 * the target OS: `--target` exists to fail loudly instead of shipping a binary
 * for the wrong platform. Normally invoked through `pnpm run desktop`.
 */
import { build } from 'esbuild';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM_TARGET = { win32: 'win', linux: 'linux', darwin: 'mac' };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, 'src-tauri', 'runtime');
const cli = join(root, 'dist', 'cli', 'bin.js');
const ui = join(root, 'app', '.output', 'public');

function parseTarget(argv) {
  const flag = argv.find((arg) => arg.startsWith('--target='));
  const requested = flag ? flag.slice('--target='.length) : (PLATFORM_TARGET[process.platform] ?? process.platform);
  if (!['win', 'linux', 'mac'].includes(requested)) {
    throw new Error(`unknown target "${requested}" (expected win, linux or mac)`);
  }
  return requested;
}

function requirePath(path, hint) {
  if (!existsSync(path)) {
    console.error(`missing ${path}\n  → ${hint}`);
    process.exit(1);
  }
}

let target;
try {
  target = parseTarget(process.argv.slice(2));
} catch (error) {
  console.error(`prepare-desktop: ${error.message}`);
  process.exit(1);
}

const host = PLATFORM_TARGET[process.platform] ?? process.platform;
if (target !== host) {
  console.error(
    `prepare-desktop: cannot build for "${target}" on "${host}".\n` +
      '  The bundled Node runtime is copied from the build machine, so run this on the\n' +
      `  target OS (or a CI runner for it) instead of cross-compiling.`,
  );
  process.exit(1);
}

requirePath(cli, 'run `pnpm run build` first');
requirePath(ui, 'run `pnpm run build:gui` first');

rmSync(runtime, { recursive: true, force: true });
mkdirSync(runtime, { recursive: true });

await build({
  entryPoints: [cli],
  outfile: join(runtime, 'udmt-core.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['node:*'],
  // Every `import.meta.url` in the core is guarded (`typeof __filename === 'string'`,
  // or a try/catch), so in the CommonJS bundle the CJS fallback is the correct value.
  // Declaring it here keeps esbuild from emitting its "import.meta is empty" warning.
  define: { 'import.meta.url': 'undefined' },
  logLevel: 'warning',
});

const nodeName = target === 'win' ? 'node.exe' : 'node';
const nodeTarget = join(runtime, nodeName);
copyFileSync(process.execPath, nodeTarget);
if (target !== 'win') chmodSync(nodeTarget, 0o755);

cpSync(ui, join(runtime, 'ui'), { recursive: true });

const mb = (path) => `${(statSync(path).size / 1024 / 1024).toFixed(1)} MB`;
console.log(`target: ${target} (${process.platform}/${process.arch})`);
console.log(`node:   ${process.execPath} → ${nodeName} ${mb(nodeTarget)}`);
console.log(`core:   udmt-core.cjs ${mb(join(runtime, 'udmt-core.cjs'))}`);
console.log(`ui:     runtime/ui`);
console.log(`done → ${runtime}`);
