#!/usr/bin/env node
/**
 * One command for the desktop release build on Windows, Linux and macOS.
 *
 *   pnpm run desktop                 # build for the current OS
 *   pnpm run desktop -- --bundles=deb
 *   pnpm run desktop -- --skip-frontend    # Rust/runtime only
 *
 * Steps: tsc → nuxt generate → runtime payload (node + core + ui) → tauri build.
 * Bundle targets come from `src-tauri/tauri.<platform>.conf.json`, which Tauri
 * merges over the base config automatically.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportSignature, signWindowsArtifacts, signingConfigured } from './sign-windows.mjs';
import { raiseArtifactsToMedium, warnAboutLowIntegrityFolder } from './windows-integrity.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORM_TARGET = { win32: 'win', linux: 'linux', darwin: 'mac' };
// Names vary with product name and CPU architecture, so report by scanning the
// bundle folders instead of hard-coding file names.
const BUNDLE_DIRS = {
  win: ['bundle/nsis', 'bundle/msi'],
  linux: ['bundle/deb', 'bundle/appimage', 'bundle/rpm'],
  mac: ['bundle/dmg', 'bundle/macos'],
};
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const args = process.argv.slice(2);
const target = PLATFORM_TARGET[process.platform] ?? process.platform;
const skipFrontend = args.includes('--skip-frontend');
const bundles = args.find((arg) => arg.startsWith('--bundles='))?.split('=')[1];

const env = { ...process.env };

/**
 * rustup installs cargo into `~/.cargo/bin` and relies on the shell profile to put
 * it on PATH. When these scripts are launched from an IDE, a task runner or a
 * pnpm shim, that profile was never sourced, and `tauri build` then dies with
 * "cargo metadata ... program not found". Locate the toolchain ourselves and add
 * its directory to the child environment instead of asking for a machine setup.
 */
function ensureCargoOnPath() {
  const candidates = [
    process.env.CARGO_HOME && join(process.env.CARGO_HOME, 'bin'),
    join(homedir(), '.cargo', 'bin'),
  ].filter(Boolean);
  const cargoName = process.platform === 'win32' ? 'cargo.exe' : 'cargo';

  // Already resolvable: nothing to do.
  const onPath = spawnSync(cargoName, ['--version'], { env, stdio: 'ignore', shell: false });
  if (onPath.status === 0) return;

  for (const dir of candidates) {
    if (!existsSync(join(dir, cargoName))) continue;
    // Windows spells the variable `Path` or `PATH` depending on where it came from;
    // reuse the key that is already there so the child sees one variable, not two.
    const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
    env[key] = `${dir}${delimiter}${env[key] ?? ''}`;
    console.log(`rust:  adding ${dir} to PATH for the Tauri build`);
    return;
  }

  console.error(
    '\n✗ cargo not found.\n' +
      '  Install the Rust toolchain, then reopen the terminal:\n' +
      '    https://rustup.rs\n' +
      '  On Windows also install the "Desktop development with C++" workload from the\n' +
      '  Visual Studio Build Tools, which provides the MSVC linker Tauri needs.',
  );
  process.exit(1);
}

function run(command, commandArgs) {
  const label = [command, ...commandArgs].join(' ');
  console.log(`\n▸ ${label}`);
  // `.cmd` shims need a shell on Windows; the node binary itself must NOT go
  // through one, or an install path with spaces breaks the command line.
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
  });
  if (result.status !== 0) {
    console.error(`\n✗ failed: ${label}`);
    process.exit(result.status ?? 1);
  }
}

if (!['win', 'linux', 'mac'].includes(target)) {
  console.error(`desktop: unsupported host platform "${process.platform}"`);
  process.exit(1);
}

// A Low-integrity checkout is not fatal, but the artifacts it produces inherit that
// label and then fail on the target machine (NSIS temp files, blank WebView2 window),
// so say it once up front instead of leaving it to a confusing runtime failure.
if (process.platform === 'win32') warnAboutLowIntegrityFolder(root, 'the project folder');

// Fail on a missing toolchain before spending minutes on the frontend build.
ensureCargoOnPath();

if (!skipFrontend) {
  run(pnpm, ['run', 'build']);
  run(pnpm, ['run', 'build:gui']);
}
run(process.execPath, ['scripts/prepare-desktop.mjs', `--target=${target}`]);
run(pnpm, ['exec', 'tauri', 'build', ...(bundles ? ['--bundles', bundles] : [])]);

const releaseDir = join(root, 'src-tauri', 'target', 'release');

// Tauri writes the shell binary, the runtime payload and the installer bundle; sign and
// de-label all of them before anyone can pick them up.
if (target === 'win') {
  const signingTargets = [
    join(releaseDir, 'udmt-desktop.exe'),
    join(releaseDir, 'runtime'),
    join(releaseDir, 'bundle', 'nsis'),
    join(releaseDir, 'bundle', 'msi'),
  ];
  // Sign first: signtool rewrites the file, which would drop a label set before it.
  if (!signWindowsArtifacts(signingTargets)) {
    console.error('\n✗ code signing failed — the installer is not signed.');
    process.exit(1);
  }

  const { raised, failed } = raiseArtifactsToMedium(signingTargets);
  if (raised.length > 0) {
    console.log('\nintegrity: raised to Medium so the app runs without elevation:');
    for (const path of raised) console.log(`  ✓ ${path.slice(root.length + 1)}`);
  }
  if (failed.length > 0) {
    console.error('\n✗ could not raise the integrity level of:');
    for (const path of failed) console.error(`  ${path.slice(root.length + 1)}`);
    console.error('  These files run at Low integrity: the installer will need admin rights');
    console.error('  and the app window will stay blank. Re-run:');
    console.error('    icacls "<folder>" /setintegritylevel (OI)(CI)Medium /T');
    process.exit(1);
  }
}

console.log(`\nArtifacts (${target}):`);
const found = [];
for (const dir of BUNDLE_DIRS[target]) {
  const absolute = join(releaseDir, dir);
  if (!existsSync(absolute)) continue;
  for (const name of readdirSync(absolute, { recursive: true })) {
    const file = String(name);
    // Only list the interesting outputs, not every file inside a .app folder.
    if (/\.(exe|msi|deb|rpm|AppImage|dmg)$/.test(file)) found.push(join(dir, file).split(/[\\/]/).join('/'));
  }
}
for (const file of found) console.log(`  ✓ src-tauri/target/release/${file}`);
if (found.length === 0) {
  console.error('\nNo installer artifact found — check the Tauri output above.');
  process.exit(1);
}

if (target === 'win') {
  console.log('\nSignature:');
  reportSignature([join(releaseDir, 'bundle', 'nsis'), join(releaseDir, 'bundle', 'msi')]);
  if (!signingConfigured()) {
    console.log(
      '\nNote: these artifacts are unsigned, so SmartScreen will warn on first run.\n' +
        '      See "Code signing" in docs/desktop/packaging.md to sign them.',
    );
  }
}
