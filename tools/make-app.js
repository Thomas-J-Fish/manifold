#!/usr/bin/env node
'use strict';
/* Builds Manifold.app — a real, double-clickable macOS application.
 *
 * There is no packaging framework here on purpose. The `electron` npm package
 * already ships a complete, working Electron.app for this machine's
 * architecture, and a macOS application bundle is just a directory with a known
 * shape. So this copies that bundle, renames the executable and its helpers,
 * swaps in our Info.plist and icon, drops the built app into
 * Contents/Resources/app, and ad-hoc signs the result.
 *
 * That last step is not optional on Apple Silicon: modifying a signed bundle
 * invalidates its signature, and macOS kills an Apple Silicon binary whose
 * signature does not verify. An ad-hoc signature is not a developer
 * certificate — it just makes the bundle internally consistent again.
 *
 *   node tools/make-app.js [--out <dir>] [--no-verify]
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const APP_NAME = 'Manifold';
const BUNDLE_ID = 'org.manifold.app';

const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const OUT_DIR = outIndex >= 0 ? path.resolve(argv[outIndex + 1]) : path.join(ROOT, 'dist-app');
const VERIFY = !argv.includes('--no-verify');
const DEST = path.join(OUT_DIR, `${APP_NAME}.app`);

const log = (s) => process.stdout.write(`${s}\n`);
const die = (s) => {
  process.stderr.write(`\n${s}\n`);
  process.exit(1);
};
const run = (cmd, args, opts) => execFileSync(cmd, args, { stdio: 'pipe', ...opts });

// ---------------------------------------------------------------- plists

/* Electron ships XML plists, so these are edited as text rather than through
 * PlistBuddy. That keeps the script testable off macOS and removes a dependency
 * on another tool's exit codes. A binary plist would defeat text editing, so
 * that case falls back to PlistBuddy, which is always present on macOS. */
const isBinaryPlist = (file) => {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(6);
  try {
    fs.readSync(fd, buf, 0, 6, 0);
  } finally {
    fs.closeSync(fd);
  }
  return buf.toString('latin1') === 'bplist';
};

const xmlEscape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function readPlistString(file, key) {
  if (!fs.existsSync(file) || isBinaryPlist(file)) {
    try {
      return String(run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, file])).trim();
    } catch {
      return null;
    }
  }
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(
    fs.readFileSync(file, 'utf8'),
  );
  return m ? m[1] : null;
}

/** Sets string keys in a plist, adding any that are not already there. */
function writePlist(file, keys) {
  if (!fs.existsSync(file)) return;
  if (isBinaryPlist(file)) {
    for (const k of Object.keys(keys)) {
      const set = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Set :${k} ${keys[k]}`, file], { stdio: 'pipe' });
      if (set.status !== 0) {
        spawnSync('/usr/libexec/PlistBuddy', ['-c', `Add :${k} string ${keys[k]}`, file], { stdio: 'pipe' });
      }
    }
    return;
  }
  let xml = fs.readFileSync(file, 'utf8');
  for (const k of Object.keys(keys)) {
    const value = `<string>${xmlEscape(keys[k])}</string>`;
    const existing = new RegExp(`(<key>${k}</key>\\s*)<string>[^<]*</string>`);
    if (existing.test(xml)) xml = xml.replace(existing, `$1${value}`);
    else xml = xml.replace(/<dict>/, `<dict>\n\t<key>${k}</key>\n\t${value}`);
  }
  fs.writeFileSync(file, xml);
}

// ---------------------------------------------------------------- preflight

// MANIFOLD_BUILD_TEST lets the bundling logic be exercised against a stand-in
// on another OS, which is how this script is tested. It is never set in use.
if (process.platform !== 'darwin' && !process.env.MANIFOLD_BUILD_TEST) {
  die(
    'This builds a macOS .app, so it has to run on macOS.\n' +
      'On Windows or Linux, run `npm start` instead — the app itself is cross-platform.',
  );
}

for (const required of ['out/renderer/index.html', 'out/main/main.js']) {
  if (!fs.existsSync(path.join(ROOT, required))) {
    die(`${required} is missing — run \`npm run build\` first.`);
  }
}

const electronDir = path.join(ROOT, 'node_modules', 'electron');
if (!fs.existsSync(electronDir)) {
  die('Electron is not installed yet.\nRun `npm install` in this folder first.');
}
const srcApp = path.join(electronDir, 'dist', 'Electron.app');
if (!fs.existsSync(srcApp)) {
  die(
    'Electron downloaded only its stub — node_modules/electron/dist is incomplete.\n' +
      'Fix it with:  node node_modules/electron/install.js',
  );
}
const electronVersion = JSON.parse(
  fs.readFileSync(path.join(electronDir, 'package.json'), 'utf8'),
).version;
log(`Electron ${electronVersion} found.`);

// ---------------------------------------------------------------- copy

fs.mkdirSync(OUT_DIR, { recursive: true });
if (fs.existsSync(DEST)) {
  log(`Replacing the existing ${APP_NAME}.app…`);
  fs.rmSync(DEST, { recursive: true, force: true });
}
log('Copying the Electron runtime…');
// ditto preserves symlinks, permissions and extended attributes; a plain
// recursive copy flattens the framework's version symlinks and the result
// will not launch.
run('ditto', [srcApp, DEST]);

const CONTENTS = path.join(DEST, 'Contents');
const MACOS = path.join(CONTENTS, 'MacOS');
const RESOURCES = path.join(CONTENTS, 'Resources');
const FRAMEWORKS = path.join(CONTENTS, 'Frameworks');

// ---------------------------------------------------------------- rename

const oldExe = path.join(MACOS, 'Electron');
const newExe = path.join(MACOS, APP_NAME);
if (fs.existsSync(oldExe)) fs.renameSync(oldExe, newExe);
if (!fs.existsSync(newExe)) die('The Electron bundle did not contain the executable we expected.');
fs.chmodSync(newExe, 0o755);

/* The helper processes are located by a path built from the bundle name, with a
 * fallback to the stock "Electron Helper" names. Renaming them keeps Activity
 * Monitor honest and stops this app being confused with every other Electron
 * app the user has open. */
const helpers = fs.existsSync(FRAMEWORKS)
  ? fs.readdirSync(FRAMEWORKS).filter((n) => /^Electron Helper.*\.app$/.test(n))
  : [];
for (const helper of helpers) {
  const suffix = helper.replace(/^Electron Helper/, '').replace(/\.app$/, ''); // '' | ' (GPU)' | ...
  const from = path.join(FRAMEWORKS, helper);
  const to = path.join(FRAMEWORKS, `${APP_NAME} Helper${suffix}.app`);
  const exeFrom = path.join(from, 'Contents', 'MacOS', `Electron Helper${suffix}`);
  const exeTo = path.join(from, 'Contents', 'MacOS', `${APP_NAME} Helper${suffix}`);
  if (fs.existsSync(exeFrom)) fs.renameSync(exeFrom, exeTo);
  writePlist(path.join(from, 'Contents', 'Info.plist'), {
    CFBundleExecutable: `${APP_NAME} Helper${suffix}`,
    CFBundleName: `${APP_NAME} Helper${suffix}`,
    CFBundleDisplayName: `${APP_NAME} Helper${suffix}`,
    CFBundleIdentifier: `${BUNDLE_ID}.helper${suffix.replace(/[^A-Za-z0-9]+/g, '').toLowerCase()}`,
  });
  fs.renameSync(from, to);
}
if (helpers.length) log(`Renamed ${helpers.length} helper process${helpers.length === 1 ? '' : 'es'}.`);

// ---------------------------------------------------------------- app payload

log('Installing the app itself…');
const APPDIR = path.join(RESOURCES, 'app');
fs.rmSync(APPDIR, { recursive: true, force: true });
fs.mkdirSync(APPDIR, { recursive: true });
for (const item of ['out', 'package.json', 'LICENSE', 'README.md', 'build/icon.png']) {
  const from = path.join(ROOT, item);
  if (!fs.existsSync(from)) continue;
  const to = path.join(APPDIR, item);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  run('ditto', [from, to]);
}
/* Electron falls back to default_app.asar when Resources/app is absent or
 * broken. Removing that fallback means a damaged copy fails loudly instead of
 * silently opening Electron's welcome screen, which is a far more confusing
 * thing for a user to be shown. */
fs.rmSync(path.join(RESOURCES, 'default_app.asar'), { force: true });

// ---------------------------------------------------------------- icon

const icns = path.join(ROOT, 'build', 'manifold.icns');
if (!fs.existsSync(icns)) die('build/manifold.icns is missing — run `python3 build/make-icon.py`.');
fs.copyFileSync(icns, path.join(RESOURCES, 'manifold.icns'));
fs.rmSync(path.join(RESOURCES, 'electron.icns'), { force: true });

// ---------------------------------------------------------------- Info.plist

log('Writing Info.plist…');
const year = new Date().getFullYear();
// Take the OS floor from the runtime being wrapped rather than guessing, so the
// app never claims to support a macOS this Electron cannot run on.
let minOS = '11.0';
const runtimeMin = readPlistString(path.join(srcApp, 'Contents', 'Info.plist'), 'LSMinimumSystemVersion');
if (runtimeMin && /^\d+(\.\d+)*$/.test(runtimeMin)) minOS = runtimeMin;
else log(`  ! could not read the runtime's minimum macOS; declaring ${minOS}`);

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundleIconFile</key><string>manifold.icns</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${pkg.version}</string>
  <key>CFBundleVersion</key><string>${pkg.version}</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.education</string>
  <key>LSMinimumSystemVersion</key><string>${minOS}</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSHumanReadableCopyright</key><string>MIT licence. © ${year} Manifold contributors.</string>
  <key>NSRequiresAquaSystemAppearance</key><false/>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>Manifold Project</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Owner</string>
      <key>CFBundleTypeExtensions</key>
      <array><string>manifold</string></array>
      <key>CFBundleTypeIconFile</key><string>manifold.icns</string>
    </dict>
    <dict>
      <key>CFBundleTypeName</key><string>Delimited Text</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key>
      <array><string>public.comma-separated-values-text</string></array>
      <key>CFBundleTypeExtensions</key>
      <array><string>csv</string><string>tsv</string></array>
    </dict>
  </array>
  <key>UTExportedTypeDeclarations</key>
  <array>
    <dict>
      <key>UTTypeIdentifier</key><string>${BUNDLE_ID}.project</string>
      <key>UTTypeDescription</key><string>Manifold Project</string>
      <key>UTTypeConformsTo</key><array><string>public.json</string></array>
      <key>UTTypeTagSpecification</key>
      <dict><key>public.filename-extension</key><array><string>manifold</string></array></dict>
    </dict>
  </array>
</dict>
</plist>
`;
fs.writeFileSync(path.join(CONTENTS, 'Info.plist'), plist);

// ---------------------------------------------------------------- sign

log('Signing…');
try {
  run('xattr', ['-cr', DEST]);
} catch {
  /* nothing to clear */
}

let signed = false;
try {
  run('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', DEST]);
  signed = true;
} catch (err) {
  // Sign the nested code first, then the outer bundle. Slower, but it copes
  // with layouts that --deep gets wrong.
  try {
    const inner = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        let st;
        try {
          st = fs.lstatSync(p);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          if (/\.(app|framework)$/.test(name)) inner.push(p);
          walk(p);
        }
      }
    };
    if (fs.existsSync(FRAMEWORKS)) walk(FRAMEWORKS);
    for (const p of inner.reverse()) {
      try {
        run('codesign', ['--force', '--sign', '-', '--timestamp=none', p]);
      } catch {
        /* keep going; the outer signature is the one that matters most */
      }
    }
    run('codesign', ['--force', '--sign', '-', '--timestamp=none', DEST]);
    signed = true;
  } catch (err2) {
    log(`  ! Could not sign the bundle: ${err2.stderr ? String(err2.stderr).trim() : err2.message}`);
    log('    On Apple Silicon the app will not launch without a signature.');
  }
}
if (signed) {
  try {
    run('codesign', ['--verify', '--deep', '--strict', DEST]);
    log('  signature verified.');
  } catch (err) {
    log(`  ! codesign --verify was unhappy: ${err.stderr ? String(err.stderr).trim() : err.message}`);
  }
}

// ---------------------------------------------------------------- verify

if (VERIFY && process.platform === 'darwin') {
  log('Launching it once to check it actually works…');
  const marker = path.join(os.tmpdir(), `manifold-smoke-${process.pid}.json`);
  const result = spawnSync(newExe, [], {
    env: { ...process.env, MANIFOLD_SELFTEST: marker },
    stdio: 'pipe',
    timeout: 90000,
  });
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(marker, 'utf8'));
    fs.rmSync(marker, { force: true });
  } catch {
    /* no report written */
  }
  if (report && report.ok) {
    log(`  ${report.checks} checks passed inside the built app.`);
  } else {
    const detail =
      (report && report.error) ||
      String(result.stderr || '')
        .trim()
        .split('\n')
        .slice(-6)
        .join('\n');
    die(
      `The bundle was built but it did not start cleanly.\n${detail || 'no output'}\n\n` +
        `The app is at ${DEST} — try opening it by hand to see what macOS says.`,
    );
  }
}

const sizeMb = Number(String(run('du', ['-sm', DEST])).trim().split(/\s+/)[0]);
log('');
log(`${APP_NAME}.app is ready — ${sizeMb} MB`);
log(`  ${DEST}`);
