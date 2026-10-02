#!/usr/bin/env node
/**
 * PowerShell-free desktop shortcut writer (MS-SHLLINK .lnk, pure Node fs).
 *
 * Why: AhnLab Safe Transaction (Execution/MDP.Powershell.M2514) kills hidden
 * powershell.exe that creates .lnk via WScript.Shell COM. Writing the binary
 * directly avoids spawning PowerShell/COM entirely.
 *
 * Usage:
 *   node tools/desktop-shortcut.mjs [--root <appRoot>] [--name "MY Agent"] [--desktop <dir>]
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function stringData(text) {
  return Buffer.concat([u16(text.length), Buffer.from(text, 'utf16le')]);
}

// My Computer {20D04FE0-3AEA-1069-A2D8-08002B30309D}
const CLSID_MY_COMPUTER = Buffer.from('e04fd020ea3a6910a2d808002b30309d', 'hex');

function shellItem(body) {
  return Buffer.concat([u16(body.length + 2), body]);
}

/** File/folder entry shell item with a v9 BEEF0004 extension carrying the long name. */
function fileEntryItem(name, isDir) {
  const primary = Buffer.concat([Buffer.from(name, 'latin1'), Buffer.from([0])]);
  const primaryPadded = primary.length % 2 ? Buffer.concat([primary, Buffer.from([0])]) : primary;
  const head = Buffer.concat([
    Buffer.from([isDir ? 0x31 : 0x32, 0x00]),
    u32(0), // file size (unknown)
    u32(0), // DOS date/time
    u16(isDir ? 0x10 : 0x20),
    primaryPadded,
  ]);
  const extOffset = head.length + 2; // offset from item start (size field included)
  const longName = Buffer.concat([Buffer.from(name, 'utf16le'), Buffer.alloc(2)]);
  const extBody = Buffer.concat([
    u16(0x0009), // version
    u32(0xbeef0004),
    u32(0), // creation
    u32(0), // access
    u16(0x002e), // version identifier (Win8+)
    u16(0),
    Buffer.alloc(8), // MFT reference
    Buffer.alloc(8),
    u16(0), // long string size
    u32(0),
    u32(0),
    longName,
    u16(extOffset),
  ]);
  const ext = Buffer.concat([u16(extBody.length + 2), extBody]);
  return shellItem(Buffer.concat([head, ext]));
}

/** LinkTargetIDList for an absolute local path: My Computer \ drive \ dirs... \ file. */
export function buildIdList(target) {
  const parts = path.win32.normalize(target).split('\\').filter(Boolean);
  const drive = parts.shift();
  if (!drive || !/^[A-Za-z]:$/.test(drive)) throw new Error(`absolute drive path required: ${target}`);
  const items = [
    shellItem(Buffer.concat([Buffer.from([0x1f, 0x50]), CLSID_MY_COMPUTER])),
    shellItem(Buffer.concat([Buffer.from([0x2f]), Buffer.from(`${drive.toUpperCase()}\\`, 'latin1'), Buffer.alloc(19)])),
    ...parts.map((name, i) => fileEntryItem(name, i < parts.length - 1)),
  ];
  const list = Buffer.concat([...items, u16(0)]);
  return Buffer.concat([u16(list.length), list]);
}

/** .lnk: LinkTargetIDList + LinkInfo (local path) + Name / WorkingDir / IconLocation. */
export function buildShellLink({ target, workingDir, description, iconPath, iconIndex = 0, args = '', showCmd = 1 }) {
  const HAS_LINK_TARGET_ID_LIST = 0x01;
  const HAS_LINK_INFO = 0x02;
  const HAS_NAME = 0x04;
  const HAS_WORKING_DIR = 0x10;
  const HAS_ARGUMENTS = 0x20;
  const HAS_ICON_LOCATION = 0x40;
  const IS_UNICODE = 0x80;
  const flags = HAS_LINK_TARGET_ID_LIST | HAS_LINK_INFO | HAS_NAME | HAS_WORKING_DIR | HAS_ICON_LOCATION | IS_UNICODE
    | (args ? HAS_ARGUMENTS : 0);

  const header = Buffer.concat([
    u32(0x4c),
    Buffer.from([0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46]),
    u32(flags),
    u32(0x20), // FILE_ATTRIBUTE_ARCHIVE
    Buffer.alloc(24), // creation / access / write time
    u32(0), // file size
    u32(iconIndex),
    u32(showCmd), // 1 = SW_SHOWNORMAL, 7 = SW_SHOWMINNOACTIVE
    u16(0), // hotkey
    Buffer.alloc(10), // reserved
  ]);

  // VolumeID: fixed drive, empty label.
  const volumeId = Buffer.concat([u32(0x11), u32(3), u32(0), u32(0x10), Buffer.from([0])]);
  const localBasePath = Buffer.concat([Buffer.from(target, 'latin1'), Buffer.from([0])]);
  const commonSuffix = Buffer.from([0]);
  const localBasePathU = Buffer.concat([Buffer.from(target, 'utf16le'), Buffer.alloc(2)]);
  const commonSuffixU = Buffer.alloc(2);

  const headerSize = 0x24;
  const volumeIdOffset = headerSize;
  const localBasePathOffset = volumeIdOffset + volumeId.length;
  const commonSuffixOffset = localBasePathOffset + localBasePath.length;
  const localBasePathUOffset = commonSuffixOffset + commonSuffix.length;
  const commonSuffixUOffset = localBasePathUOffset + localBasePathU.length;
  const linkInfoSize = commonSuffixUOffset + commonSuffixU.length;

  const linkInfo = Buffer.concat([
    u32(linkInfoSize),
    u32(headerSize),
    u32(0x1), // VolumeIDAndLocalBasePath
    u32(volumeIdOffset),
    u32(localBasePathOffset),
    u32(0), // CommonNetworkRelativeLinkOffset
    u32(commonSuffixOffset),
    u32(localBasePathUOffset),
    u32(commonSuffixUOffset),
    volumeId,
    localBasePath,
    commonSuffix,
    localBasePathU,
    commonSuffixU,
  ]);

  return Buffer.concat([
    header,
    buildIdList(target),
    linkInfo,
    stringData(description),
    stringData(workingDir),
    ...(args ? [stringData(args)] : []),
    stringData(iconPath),
    u32(0), // terminal block
  ]);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(typeof args.root === 'string' ? args.root : path.join(scriptDir, '..'));
  const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'MY Agent';
  const desktop = path.resolve(
    typeof args.desktop === 'string' ? args.desktop : path.join(os.homedir(), 'Desktop'),
  );
  const exe = path.join(root, 'MYAgent.exe');
  if (!existsSync(exe)) {
    console.error(`MYAgent.exe not found: ${exe}`);
    process.exit(2);
  }
  if (!existsSync(desktop)) mkdirSync(desktop, { recursive: true });
  const lnkPath = path.join(desktop, `${name}.lnk`);
  // --no-update-check: write the per-install marker that UpdateService.TryCreate honours
  // (data/runtime/update-check.disabled). Used for the trial-branch app so a published
  // main update never overwrites it. The shortcut itself targets MYAgent.exe directly.
  if (args['no-update-check'] === true) {
    const marker = path.join(root, 'data', 'runtime', 'update-check.disabled');
    mkdirSync(path.dirname(marker), { recursive: true });
    if (!existsSync(marker)) writeFileSync(marker, 'core update check disabled for this install\n');
    console.log(`Update check disabled: ${marker}`);
  }
  const link = { target: exe, args: '', showCmd: 1 };
  writeFileSync(
    lnkPath,
    buildShellLink({ ...link, workingDir: root, description: name, iconPath: exe }),
  );
  console.log(`Desktop shortcut: ${lnkPath}`);
  console.log(`Target: ${link.target}${link.args ? ` ${link.args}` : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
