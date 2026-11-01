#!/usr/bin/env node
/**
 * Code signing for the Windows installer (optional, opt-in).
 *
 * Nothing here is required to build: with no certificate configured the script exits
 * quietly and the build stays unsigned, which only costs a SmartScreen warning on
 * first run. Point `UDMT_SIGN_CERT` at a certificate and every binary gets signed.
 *
 *   UDMT_SIGN_CERT=path/to/cert.pfx        UDMT_SIGN_CERT_PASSWORD=…  (file)
 *   UDMT_SIGN_CERT=sha1-thumbprint         (cert from a Windows store)
 *   UDMT_SIGN_CERT_SUBJECT="TM Data"       (pick from the store by subject)
 *   UDMT_SIGN_CERT_MACHINE=1               (read the machine store, needs admin)
 *   UDMT_SIGN_CERT_STORE=My                (store name; `My` holds code-signing certs)
 *   UDMT_SIGN_TIMESTAMP_URL=…              (default http://timestamp.digicert.com)
 *
 * Note the two arguments people usually get wrong, both fixed here:
 *   - `/s` takes a store *name* (`My`, `Root`, …), not a location. `CurrentUser` is a
 *     location, there is no store of that name, and signtool then reports the very
 *     unhelpful "No certificates were found that met all the given criteria".
 *   - a thumbprint needs `/sha1`; `/f` only accepts a path to a `.pfx`/`.p7b` file.
 *
 * Usage from the build script:
 *   node scripts/sign-windows.mjs <file-or-folder> [...]
 *
 * `signtool` is found on PATH or in the newest Windows SDK under
 * `%ProgramFiles(x86)%\Windows Kits\10\bin`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SIGN_EXTENSIONS = /\.(exe|dll|msi)$/i;

/** Locates `signtool.exe`: PATH first, then the newest installed Windows SDK. */
export function findSignTool() {
  if (process.platform !== 'win32') return null;
  const onPath = spawnSync('signtool', ['/?'], { encoding: 'utf8', windowsHide: true });
  // `signtool /?` prints usage and exits non-zero; a spawn error means "not found".
  if (!onPath.error) return 'signtool';

  const kits = process.env['ProgramFiles(x86)']
    ? join(process.env['ProgramFiles(x86)'], 'Windows Kits', '10', 'bin')
    : null;
  if (!kits || !existsSync(kits)) return null;
  const versions = readdirSync(kits)
    .filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    for (const arch of ['x64', 'x86']) {
      const candidate = join(kits, version, arch, 'signtool.exe');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** True when the user configured a certificate, i.e. signing is wanted. */
export function signingConfigured() {
  return Boolean(
    process.env.UDMT_SIGN_CERT || process.env.UDMT_SIGN_CERT_SUBJECT,
  );
}

/** True when `value` looks like a SHA-1 thumbprint rather than a file path. */
function looksLikeThumbprint(value) {
  return /^[0-9a-f\s]{40}$/i.test(value.trim());
}

/** Builds the signtool argument list for one file. */
function signArgs(file) {
  const cert = process.env.UDMT_SIGN_CERT?.trim();
  const subject = process.env.UDMT_SIGN_CERT_SUBJECT?.trim();
  const args = ['sign', '/fd', 'sha256', '/td', 'sha256'];
  const timestampUrl = process.env.UDMT_SIGN_TIMESTAMP_URL || 'http://timestamp.digicert.com';
  args.push('/tr', timestampUrl);

  if (cert && looksLikeThumbprint(cert)) {
    // `/f` is for files only; a thumbprint selects from a store.
    args.push('/sha1', cert.replace(/\s+/g, '').toUpperCase());
  } else if (cert) {
    args.push('/f', cert);
    if (process.env.UDMT_SIGN_CERT_PASSWORD) {
      // `sign /p` leaks the password through the process list; a `.pfx` on a build
      // agent is the usual compromise. Prefer a cert already in a store (or Azure
      // Trusted Signing) whenever a password would otherwise travel in argv.
      args.push('/p', process.env.UDMT_SIGN_CERT_PASSWORD);
    }
  } else {
    args.push('/n', subject);
  }

  // `CurrentUser`/`LocalMachine` are locations (`/sm` selects the machine one); the
  // store *name* is `My` unless the user set something else.
  const store = process.env.UDMT_SIGN_CERT_STORE;
  args.push('/s', store && store !== 'CurrentUser' && store !== 'LocalMachine' ? store : 'My');
  if (process.env.UDMT_SIGN_CERT_MACHINE === '1' || store === 'LocalMachine') {
    args.push('/sm');
  }

  args.push(file);
  return args;
}

/** Expands folders to the signable files inside them. */
function collect(targets) {
  const files = [];
  for (const target of targets) {
    if (!existsSync(target)) continue;
    if (statSync(target).isDirectory()) {
      for (const name of readdirSync(target, { recursive: true })) {
        const file = join(target, String(name));
        if (SIGN_EXTENSIONS.test(file) && statSync(file).isFile()) files.push(file);
      }
    } else if (SIGN_EXTENSIONS.test(target)) {
      files.push(target);
    }
  }
  return files;
}

/**
 * Signs every signable file under `targets`. Returns false when signing was
 * requested but failed, so the caller can decide whether that is fatal.
 */
export function signWindowsArtifacts(targets) {
  if (process.platform !== 'win32') return true;
  if (!signingConfigured()) {
    console.log(
      '\nsign:  no certificate configured — artifacts stay unsigned.\n' +
        '       Set UDMT_SIGN_CERT (or UDMT_SIGN_CERT_SUBJECT) to sign them; see\n' +
        '       docs/desktop/packaging.md.',
    );
    return true;
  }

  const signTool = findSignTool();
  if (!signTool) {
    console.error(
      'sign:  signtool.exe not found. Install the Windows SDK ("Windows SDK Signing Tools")\n' +
        '       or run from a Developer Command Prompt.',
    );
    return false;
  }

  const files = collect(targets);
  if (files.length === 0) {
    console.error('sign:  nothing to sign (no .exe/.dll/.msi under the given paths).');
    return false;
  }

  for (const file of files) {
    const result = spawnSync(signTool, signArgs(file), {
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.status !== 0) {
      console.error(`sign:  failed for ${file}`);
      return false;
    }
  }
  console.log(`sign:  signed ${files.length} file(s)`);
  return true;
}

/** Prints Authenticode status for the artifacts, so an unsigned build is obvious. */
export function reportSignature(targets) {
  if (process.platform !== 'win32') return;
  const files = collect(targets).filter((file) => file.endsWith('.exe'));
  if (files.length === 0) return;
  for (const file of files) {
    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `(Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}').Status`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    const status = (result.stdout ?? '').trim() || 'Unknown';
    console.log(`       ${status.padEnd(11)} ${file}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('sign-windows.mjs')) {
  const ok = signWindowsArtifacts(process.argv.slice(2));
  process.exit(ok ? 0 : 1);
}
