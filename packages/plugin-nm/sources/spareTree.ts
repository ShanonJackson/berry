import {Configuration, Project, hashUtils}         from '@yarnpkg/core';
import {Filename, PortablePath, npath, ppath, xfs} from '@yarnpkg/fslib';
import {spawn}                                     from 'child_process';
import crypto                                      from 'crypto';
import fs                                          from 'fs';

/**
 * A spare tree is a copy of a freshly installed root `node_modules`, made of
 * hardlinks to the same files and kept in the global folder. When an install
 * finds `node_modules` missing (typically after `rm -rf node_modules`), it
 * renames the spare tree into place instead of linking every file again, then
 * lets the regular incremental install apply whatever changed since.
 *
 * Correctness relies on the following:
 *
 * - The spare tree is only ever made from a `node_modules` that the install
 *   just created from scratch, so it can't carry over edits made to an older
 *   `node_modules` (which incremental installs don't repair).
 *
 * - Anything modified after the install finished (files written by other
 *   tools, edits) is detected by comparing mtimes to a fence created when the
 *   install finished, and makes the copy abort. Unknown dot-entries at the
 *   root of `node_modules` (`.cache` & co) are never copied.
 *
 * - Every file of the spare tree is recorded with its inode, size, mtime and
 *   mode; the tree is only used if all of them still match, which isn't the
 *   case if a file was modified through `node_modules` in the meantime.
 *
 * - The spare tree is bound to the install state file of the install that
 *   produced it, so it's discarded if any other install happened since (the
 *   build state would otherwise refer to a different tree).
 */

const SPARE_TREE_VERSION = 1;

const NODE_MODULES = `node_modules` as Filename;
const MANIFEST_FILE = `manifest` as Filename;

// Entries that Yarn itself creates at the root of `node_modules`
const KEPT_DOT_ENTRIES = [`.bin`, `.yarn-state.yml`, `.package-map.json`];

// Files that Yarn rewrites in place, so the spare tree gets its own copy of them
const COPIED_ENTRIES = [`.yarn-state.yml`, `.package-map.json`];

// Installs that went through the linker, so that the spare tree can be refreshed once they're fully done
export const spareTreeInstalls = new WeakMap<Project, SpareTreeInstall>();

export type SpareTreeInstall = {
  // Whether this install created node_modules from scratch
  isFreshTree: boolean;
  // Locations of the packages that got built, relative to the root node_modules
  builtLocations: Array<PortablePath>;
};

type SpareTreeMeta = {
  version: number;
  cwd: PortablePath;
  installStateHash: string;
};

export function getSpareTreeStore(configuration: Configuration): PortablePath {
  return ppath.join(configuration.get(`globalFolder`), `nm-spare` as Filename);
}

export function isSpareTreeSupported(configuration: Configuration) {
  return process.platform !== `win32` && configuration.get(`nmSpareTree`);
}

function getSpareTreePath(project: Project) {
  return ppath.join(getSpareTreeStore(project.configuration), hashUtils.makeHash(project.cwd).slice(0, 32) as Filename);
}

async function getInstallStateHash(project: Project) {
  try {
    return hashUtils.makeHash(await xfs.readFilePromise(project.configuration.get(`installStatePath`)));
  } catch {
    return null;
  }
}

function getUniqueSuffix() {
  return `${process.pid}-${crypto.randomBytes(4).toString(`hex`)}`;
}

/**
 * Moves the spare tree into `node_modules`, if there's one and it can be
 * trusted. Must only be called when `node_modules` doesn't exist.
 */
export async function restoreSpareTree(project: Project): Promise<boolean> {
  const spareTreePath = getSpareTreePath(project);
  if (!xfs.existsSync(spareTreePath))
    return false;

  // Renaming the spare tree first makes sure no other process can use or replace it while we check it
  const claimPath = `${spareTreePath}.${getUniqueSuffix()}.claim` as PortablePath;
  try {
    await xfs.renamePromise(spareTreePath, claimPath);
  } catch {
    return false;
  }

  const installStateHash = await getInstallStateHash(project);

  let restored = false;
  try {
    if (installStateHash !== null && isSpareTreeIntact(claimPath, {cwd: project.cwd, installStateHash})) {
      await xfs.renamePromise(ppath.join(claimPath, NODE_MODULES), ppath.join(project.cwd, NODE_MODULES));
      restored = true;
    }
  } catch {
    restored = false;
  }

  // On success only the manifest remains; otherwise the whole tree has to go, which we don't wait for
  if (restored) {
    await xfs.removePromise(claimPath).catch(() => {});
  } else {
    runSpareTreeHelper({remove: [claimPath]});
  }

  return restored;
}

function readSpareTreeMeta(spareTreePath: PortablePath): SpareTreeMeta | null {
  try {
    const fd = fs.openSync(npath.fromPortablePath(ppath.join(spareTreePath, MANIFEST_FILE)), `r`);
    try {
      const buffer = Buffer.alloc(16384);
      const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return JSON.parse(buffer.subarray(0, size).toString().split(`\n`)[0]);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function isSpareTreeIntact(claimPath: PortablePath, expected: Omit<SpareTreeMeta, `version`>) {
  let manifest: string;
  try {
    manifest = fs.readFileSync(npath.fromPortablePath(ppath.join(claimPath, MANIFEST_FILE)), `utf8`);
  } catch {
    return false;
  }

  const lines = manifest.split(`\n`);

  let meta: SpareTreeMeta;
  try {
    meta = JSON.parse(lines[0]);
  } catch {
    return false;
  }

  if (meta.version !== SPARE_TREE_VERSION || meta.cwd !== expected.cwd || meta.installStateHash !== expected.installStateHash)
    return false;

  // The manifest is written in one go and always ends with a newline
  if (lines[lines.length - 1] !== ``)
    return false;

  const nativeRoot = npath.fromPortablePath(ppath.join(claimPath, NODE_MODULES));

  for (let t = 1; t < lines.length - 1; ++t) {
    const line = lines[t];

    const separator = line.indexOf(`\t`);
    const [ino, size, mtimeNs, mode] = line.slice(0, separator).split(` `);

    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(`${nativeRoot}/${line.slice(separator + 1)}`, {bigint: true});
    } catch {
      return false;
    }

    if (`${stat.ino}` !== ino || `${stat.size}` !== size || `${stat.mtimeNs}` !== mtimeNs || `${stat.mode}` !== mode) {
      return false;
    }
  }

  return true;
}

/**
 * Called once the install is fully done (including the builds). Makes a new
 * spare tree in the background if `node_modules` was created from scratch by
 * this install, and discards the previous one otherwise, since it doesn't
 * match the install state anymore.
 */
export async function refreshSpareTree(project: Project, {isFreshTree, builtLocations}: SpareTreeInstall) {
  const spareTreeStore = getSpareTreeStore(project.configuration);
  const spareTreePath = getSpareTreePath(project);

  // An install that didn't change anything (same install state) leaves the current spare tree valid
  if (!isFreshTree) {
    const meta = readSpareTreeMeta(spareTreePath);
    if (meta === null || meta.installStateHash === await getInstallStateHash(project)) {
      return;
    }
  }

  const remove: Array<PortablePath> = [];
  if (xfs.existsSync(spareTreePath)) {
    const trashPath = `${spareTreePath}.${getUniqueSuffix()}.trash` as PortablePath;
    await xfs.renamePromise(spareTreePath, trashPath).then(() => {
      remove.push(trashPath);
    }, () => {});
  }

  const installStateHash = isFreshTree
    ? await getInstallStateHash(project)
    : null;

  if (installStateHash === null) {
    if (remove.length > 0)
      runSpareTreeHelper({remove, store: spareTreeStore});

    return;
  }

  // The fence gets its mtime from the same (coarse) clock as the files. We wait for that clock to tick once, so
  // that everything written before this point is strictly older than the fence, and anything at or past it was
  // written after the install
  await xfs.mkdirPromise(spareTreeStore, {recursive: true});
  const fencePath = `${spareTreePath}.${getUniqueSuffix()}.fence` as PortablePath;

  const touchFence = async (iteration: number) => {
    await xfs.writeFilePromise(fencePath, `${iteration}`);
    return (await xfs.statPromise(fencePath, {bigint: true})).mtimeNs;
  };

  let fenceNs: bigint | null = null;
  try {
    const initialNs = await touchFence(0);
    for (let iteration = 1; iteration <= 1000 && fenceNs === null; ++iteration) {
      await new Promise(resolve => setTimeout(resolve, 2));
      const currentNs = await touchFence(iteration);
      if (currentNs > initialNs) {
        fenceNs = currentNs;
      }
    }
  } finally {
    await xfs.removePromise(fencePath);
  }

  // The filesystem's timestamps are too coarse to tell what was written after the install
  if (fenceNs === null) {
    if (remove.length > 0)
      runSpareTreeHelper({remove, store: spareTreeStore});

    return;
  }

  const meta: SpareTreeMeta = {
    version: SPARE_TREE_VERSION,
    cwd: project.cwd,
    installStateHash,
  };

  runSpareTreeHelper({
    remove,
    store: spareTreeStore,
    refill: {
      nodeModules: npath.fromPortablePath(ppath.join(project.cwd, NODE_MODULES)),
      spareTree: npath.fromPortablePath(spareTreePath),
      tempPath: npath.fromPortablePath(`${spareTreePath}.${getUniqueSuffix()}.tmp` as PortablePath),
      fenceNs: `${fenceNs}`,
      meta: JSON.stringify(meta),
      keptDotEntries: KEPT_DOT_ENTRIES,
      copiedEntries: COPIED_ENTRIES,
      skippedEntries: builtLocations,
    },
  });
}

type SpareTreeHelperArgs = {
  remove: Array<PortablePath>;
  store?: PortablePath;
  refill?: {
    nodeModules: string;
    spareTree: string;
    tempPath: string;
    fenceNs: string;
    meta: string;
    keptDotEntries: Array<string>;
    copiedEntries: Array<string>;
    skippedEntries: Array<string>;
  };
};

// Runs in a detached process, so that the install doesn't wait for it; it must be self-contained
const SPARE_TREE_HELPER = `
const fs = require('fs');
const path = require('path');
const os = require('os');

const args = JSON.parse(process.argv[1]);

try { os.setPriority(19); } catch {}

const remove = p => { try { fs.rmSync(p, {recursive: true, force: true}); } catch {} };

for (const p of args.remove)
  remove(p);

if (args.refill) {
  const {nodeModules, spareTree, tempPath, fenceNs, meta, keptDotEntries, copiedEntries, skippedEntries} = args.refill;
  const fence = BigInt(fenceNs);
  const skipped = new Set(skippedEntries);

  const lines = [];
  const dirTimes = [];

  const copyDir = (src, dst, rel) => {
    const isRoot = rel === '';

    const dirStat = fs.lstatSync(src, {bigint: true});
    if (!isRoot && dirStat.mtimeNs >= fence)
      throw new Error('Modified after the install: ' + src);

    fs.mkdirSync(dst);

    // A directory missing some of the entries listed in the install state must look modified, so that Yarn rescans it
    let hasSkippedEntries = false;

    for (const name of fs.readdirSync(src)) {
      if (isRoot && name.startsWith('.') && !keptDotEntries.includes(name))
        continue;

      const srcPath = path.join(src, name);
      const dstPath = path.join(dst, name);
      const relPath = isRoot ? name : rel + '/' + name;

      if (skipped.has(relPath)) {
        hasSkippedEntries = true;
        continue;
      }

      const stat = fs.lstatSync(srcPath, {bigint: true});
      if (stat.isDirectory()) {
        copyDir(srcPath, dstPath, relPath);
        continue;
      }

      if (stat.mtimeNs >= fence)
        throw new Error('Modified after the install: ' + srcPath);

      if (stat.isSymbolicLink()) {
        fs.symlinkSync(fs.readlinkSync(srcPath), dstPath);
        continue;
      }

      if (!stat.isFile())
        throw new Error('Unsupported file type: ' + srcPath);

      const isCopy = isRoot && copiedEntries.includes(name);
      if (isCopy) {
        fs.copyFileSync(srcPath, dstPath);
        fs.utimesSync(dstPath, stat.atime, stat.mtime);
      } else {
        fs.linkSync(srcPath, dstPath);
      }

      const dstStat = fs.lstatSync(dstPath, {bigint: true});
      if (!isCopy && (dstStat.ino !== stat.ino || dstStat.mtimeNs !== stat.mtimeNs || dstStat.size !== stat.size))
        throw new Error('Modified while being copied: ' + srcPath);

      lines.push(dstStat.ino + ' ' + dstStat.size + ' ' + dstStat.mtimeNs + ' ' + dstStat.mode + '\\t' + relPath);
    }

    // Directories keep their timestamps (truncated to the millisecond, so never newer), as the install state relies on them; children come first
    const now = new Date(Date.now() + 1000);
    dirTimes.push(hasSkippedEntries ? [dst, now, now] : [dst, dirStat.atime, dirStat.mtime]);
  };

  try {
    fs.mkdirSync(tempPath);
    copyDir(nodeModules, path.join(tempPath, 'node_modules'), '');

    for (const [dir, atime, mtime] of dirTimes)
      fs.utimesSync(dir, atime, mtime);

    fs.writeFileSync(path.join(tempPath, 'manifest'), meta + '\\n' + lines.join('\\n') + (lines.length > 0 ? '\\n' : ''));

    // If another spare tree appeared in the meantime, we keep it rather than replace it
    fs.renameSync(tempPath, spareTree);
  } catch {
    remove(tempPath);
  }
}

// Garbage-collect what crashed processes and deleted projects left behind
if (args.store) {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(args.store)) {
      const entryPath = path.join(args.store, name);
      if (/\\.(tmp|claim|trash|fence)$/.test(name)) {
        if (now - fs.lstatSync(entryPath).mtimeMs > 24 * 60 * 60 * 1000)
          remove(entryPath);
      } else {
        let cwd = null;
        try {
          const fd = fs.openSync(path.join(entryPath, 'manifest'), 'r');
          const buffer = Buffer.alloc(16384);
          const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
          fs.closeSync(fd);
          cwd = JSON.parse(buffer.subarray(0, size).toString().split('\\n')[0]).cwd;
        } catch {}

        if (cwd === null || !fs.existsSync(cwd)) {
          remove(entryPath);
        }
      }
    }
  } catch {}
}
`;

function runSpareTreeHelper(args: SpareTreeHelperArgs) {
  const env = {...process.env};
  delete env.NODE_OPTIONS;

  try {
    const child = spawn(process.execPath, [`-e`, SPARE_TREE_HELPER, JSON.stringify(args)], {
      detached: true,
      stdio: `ignore`,
      windowsHide: true,
      env,
    });

    child.on(`error`, () => {});
    child.unref();
  } catch {}
}
