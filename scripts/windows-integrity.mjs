#!/usr/bin/env node
/**
 * Windows mandatory-integrity-level helpers for the desktop build.
 *
 * A folder can carry a *mandatory label* that every file inside inherits. When a
 * folder on the build path is labelled `Low`, everything written into it — the shell
 * binary, `runtime/node.exe`, and the NSIS installer — inherits `Low` too. A
 * Low-integrity process may not write to `%TEMP%` (Medium) and may not launch
 * `msedgewebview2.exe` (Medium), which produces the two failures this module exists
 * to prevent:
 *
 *   - the installer aborts with "error writing temporary file" and only works when
 *     launched elevated (High integrity is allowed to write everywhere),
 *   - the app opens a window with no UI at all (silent black window).
 *
 * `icacls <dir> /setintegritylevel (OI)(CI)Medium /T` rewrites the label on the files
 * we are about to hand out, which is enough: ACLs travel with the file, integrity
 * labels do not survive a normal copy/download, so a recipient's copy inherits
 * whatever their own download folder has (Medium).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

const isWindows = process.platform === 'win32';
const LOW_LEVELS = new Set(['low', 'untrusted']);

/** Runs icacls and returns its combined output (never throws). */
function icacls(args) {
  const result = spawnSync('icacls', args, { encoding: 'utf8', windowsHide: true });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/**
 * Reads the mandatory label of a path, e.g. `low` / `medium` / `high`.
 * Returns `null` when it cannot be determined (non-Windows, missing path).
 */
export function integrityLevel(path) {
  if (!isWindows || !existsSync(path)) return null;
  for (const line of icacls([path]).split(/\r?\n/)) {
    const match = /Mandatory Label\\([^:]+):/.exec(line);
    if (!match) continue;
    const level = match[1].trim().toLowerCase();
    return level.split(/\s+/)[0];
  }
  return null;
}

/** True when `path` (or a folder above it) hands out a Low label. */
export function isLowIntegrity(path) {
  const level = integrityLevel(path);
  return level !== null && LOW_LEVELS.has(level);
}

/** `Everyone:(DENY)(...)` inherited from a parent folder: build steps cannot clean up. */
export function hasInheritedDeny(path) {
  if (!isWindows || !existsSync(path)) return false;
  return icacls([path])
    .split(/\r?\n/)
    .some((line) => /\(I\)/.test(line) && /\(DENY\)/i.test(line) && /Everyone|S-1-1-0/i.test(line));
}

/** Rewrites the label of `path` to Medium, recursively for folders. */
function setMedium(path) {
  const args = statSync(path).isDirectory()
    ? [path, '/setintegritylevel', '(OI)(CI)Medium', '/T', '/C', '/Q']
    : [path, '/setintegritylevel', 'Medium'];
  const output = icacls(args);
  return !/Failed processing [1-9]/.test(output);
}

/**
 * Makes sure the artifacts we hand out are runnable at Medium integrity.
 *
 * `paths` are the loose files and folders Tauri produced. Folders are fixed
 * recursively, so `runtime/` and `bundle/` only need one entry each.
 */
export function raiseArtifactsToMedium(paths) {
  if (!isWindows) return { checked: [], raised: [], failed: [] };
  const checked = [];
  const raised = [];
  const failed = [];

  for (const path of paths) {
    if (!existsSync(path)) continue;
    const level = integrityLevel(path);
    checked.push({ path, level });
    if (level === null || !LOW_LEVELS.has(level)) continue;
    if (setMedium(path)) raised.push(path);
    else failed.push(path);
  }

  // A folder fix is recursive but does not touch the folder entry itself.
  for (const path of paths) {
    if (!existsSync(path) || !statSync(path).isDirectory()) continue;
    if (LOW_LEVELS.has(integrityLevel(path) ?? '')) {
      icacls([path, '/setintegritylevel', '(OI)(CI)Medium', '/C', '/Q']);
    }
  }

  return { checked, raised, failed };
}

/**
 * Pre-build check: warn once, before minutes of compiling, when the checkout itself
 * sits in a Low-labelled tree. The build still works; only the artifacts need fixing,
 * which `raiseArtifactsToMedium` does after `tauri build`.
 */
export function warnAboutLowIntegrityFolder(path, label) {
  if (!isWindows || !existsSync(path)) return false;
  if (!isLowIntegrity(path)) return false;
  console.warn(
    `\n! ${label} is in a Low-integrity folder (${path}).\n` +
      '  Windows files created here inherit that label, and Low integrity cannot write to\n' +
      '  %TEMP% or start the WebView2 browser. The build will fix the artifacts it emits\n' +
      '  automatically; if you copy them elsewhere, run:\n' +
      `    icacls "<folder>" /setintegritylevel (OI)(CI)Medium /T`,
  );
  if (hasInheritedDeny(path)) {
    console.warn(
      '  The folder also inherits a DENY ACE for Everyone; if a build step fails to\n' +
        '  replace a file, delete that file by hand or build from a normal folder.',
    );
  }
  return true;
}
