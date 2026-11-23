import {Configuration, Project, hashUtils} from '@yarnpkg/core';
import {Filename, PortablePath, npath, ppath, xfs} from '@yarnpkg/fslib';
import {spawn}                                     from 'child_process';
import crypto                                      from 'crypto';
import fs                                          from 'fs';
import os                                          from 'os';
import {Worker}                                    from 'worker_threads';

/**
 * A spare tree is a copy of a freshly installed `node_modules` folder (the
 * root one, or the one of a workspace), made of hardlinks to the same files and
 * kept in the global folder. When an install finds a folder missing (typically
 * after `rm -rf node_modules`), it renames the folder's spare tree into place
 * instead of linking or copying every file again, then lets the regular install
 * apply whatever changed since.
 *
 * Correctness relies on the following:
 *
 * - A spare tree is only ever made from a folder that the install just created
 *   from scratch, so it can't carry over edits made to an older folder (which
 *   incremental installs don't repair).
 *
 * - Anything modified after the install finished (files written by other
 *   tools, edits) is detected by comparing mtimes to a fence created when the
 *   install finished, and makes the copy abort. Unknown dot-entries at the
 *   root of a folder (`.cache` & co) are never copied.
 *
 * - Every file of a spare tree is recorded with its inode, size, mtime and
 *   mode, and the tree is only used if all of them still match (they don't if
 *   a file was modified through node_modules, since they share their inodes).
 *
 * - A spare tree is bound to the install state of the install that produced
 *   it, and to the nmMode, so it's discarded if any other install happened
 *   since (the build state would otherwise refer to another tree).
 *
 * - Packages that get built are left out, so restoring a spare tree relinks
 *   and rebuilds them exactly like a fresh install does.
 */

const SPARE_TREE_VERSION = 1;

const NODE_MODULES = `node_modules` as Filename;
const MANIFEST_FILE = `manifest` as Filename;

// Entries that Yarn itself creates at the root of node_modules folders
const KEPT_DOT_ENTRIES = [`.bin`, `.yarn-state.yml`, `.package-map.json`];

// Files that Yarn rewrites in place (only in the root node_modules), so spare trees get their own copy of them
const COPIED_ENTRIES = [`.yarn-state.yml`, `.package-map.json`];

// Below this many files, checking a spare tree is faster than starting worker threads to do it
const PARALLEL_VERIFICATION_THRESHOLD = 20000;

// How long we wait for the filesystem clock to tick when making the fence (it usually ticks every few milliseconds)
const FENCE_TIMEOUT_MS = 50;

export type SpareTreeInstall = {
  // The node_modules folders that this install created from scratch (relative to the project)
  freshFolders: Array<PortablePath>;
  // Locations of the packages that got built (relative to the project)
  builtLocations: Array<PortablePath>;
};

// Installs that went through the linker, so that the spare trees can be refreshed once they're fully done
export const spareTreeInstalls = new WeakMap<Project, SpareTreeInstall>();

// Folders whose spare tree was restored by the current install
const restoredFolders = new WeakMap<Project, Set<PortablePath>>();

type SpareTreeMeta = {
  version: number;
  cwd: PortablePath;
  folder: PortablePath;
  nmMode: string;
  installStateHash: string;
};

export function getSpareTreeStore(configuration: Configuration): PortablePath {
  return ppath.join(configuration.get(`globalFolder`), `nm-spare` as Filename);
}

/**
 * Spare trees only pay off on machines that keep their global folder between
 * installs, so they're off on CI unless enabled explicitly.
 */
export function isSpareTreeEnabled(configuration: Configuration) {
  if (process.platform === `win32`)
    return false;

  if (typeof configuration.sources.get(`nmSpareTree`) !== `undefined`)
    return configuration.get(`nmSpareTree`);

  return !configuration.isCI;
}

// The node_modules folders of the root and of every workspace, relative to the project
export function getNodeModulesFolders(project: Project): Array<PortablePath> {
  const folders = new Set<PortablePath>([NODE_MODULES as PortablePath]);
  for (const workspace of project.workspaces)
    folders.add(ppath.join(ppath.relative(project.cwd, workspace.cwd), NODE_MODULES));

  return [...folders];
}

export async function getMissingNodeModulesFolders(project: Project) {
  const missing: Array<PortablePath> = [];
  for (const folder of getNodeModulesFolders(project))
    if (!await xfs.lstatPromise(ppath.join(project.cwd, folder)).then(() => true, () => false))
      missing.push(folder);

  return missing;
}

export function getRestoredFolders(project: Project): ReadonlySet<PortablePath> {
  return restoredFolders.get(project) ?? new Set();
}

function getSpareTreePath(project: Project, folder: PortablePath) {
  return ppath.join(getSpareTreeStore(project.configuration), hashUtils.makeHash(project.cwd, folder).slice(0, 32) as Filename);
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

function readSpareTreeManifest(spareTreePath: PortablePath, {full}: {full: boolean}): {meta: SpareTreeMeta, lines: Array<string>} | null {
  try {
    const manifestPath = npath.fromPortablePath(ppath.join(spareTreePath, MANIFEST_FILE));

    let content: string;
    if (full) {
      content = fs.readFileSync(manifestPath, `utf8`);
    } else {
      const fd = fs.openSync(manifestPath, `r`);
      try {
        const buffer = Buffer.alloc(16384);
        content = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString();
      } finally {
        fs.closeSync(fd);
      }
    }

    const lines = content.split(`\n`);
    return {meta: JSON.parse(lines[0]), lines: full ? lines : []};
  } catch {
    return null;
  }
}

/**
 * Moves the spare trees of the given (missing) folders into place, for those
 * that have one that can be trusted. Returns the folders that got restored.
 */
export async function restoreSpareTrees(project: Project, folders: Array<PortablePath>): Promise<Set<PortablePath>> {
  const restored = new Set<PortablePath>();

  const installStateHash = await getInstallStateHash(project);
  if (installStateHash === null)
    return restored;

  const expected = {
    version: SPARE_TREE_VERSION,
    cwd: project.cwd,
    nmMode: project.configuration.get(`nmMode`),
    installStateHash,
  };

  const remove: Array<PortablePath> = [];
  const claims: Array<{folder: PortablePath, claimPath: PortablePath, treePath: PortablePath, lines: Array<string>}> = [];

  for (const folder of folders) {
    const spareTreePath = getSpareTreePath(project, folder);
    if (!xfs.existsSync(spareTreePath))
      continue;

    // Renaming the spare tree first makes sure no other process can use or replace it while we check it; these
    // metadata calls are sync since they're cheaper than a round-trip through the threadpool
    const claimPath = `${spareTreePath}.${getUniqueSuffix()}.claim` as PortablePath;
    try {
      xfs.renameSync(spareTreePath, claimPath);
    } catch {
      continue;
    }

    const manifest = readSpareTreeManifest(claimPath, {full: true});
    const treePath = ppath.join(claimPath, NODE_MODULES);

    const isValid = manifest !== null
      && manifest.meta.version === expected.version
      && manifest.meta.cwd === expected.cwd
      && manifest.meta.folder === folder
      && manifest.meta.nmMode === expected.nmMode
      && manifest.meta.installStateHash === expected.installStateHash
      // The manifest is written in one go and always ends with a newline
      && manifest.lines[manifest.lines.length - 1] === ``
      && xfs.existsSync(treePath);

    if (isValid) {
      claims.push({folder, claimPath, treePath, lines: manifest.lines.slice(1, -1)});
    } else {
      remove.push(claimPath);
    }
  }

  // All the folders are checked together, so that the work is shared between threads however it's split between folders
  const modified = claims.length > 0
    ? await findModifiedSpareTrees(claims.map(claim => npath.fromPortablePath(claim.treePath)), claims.map(claim => claim.lines))
    : new Set<number>();

  for (const [index, {folder, claimPath, treePath}] of claims.entries()) {
    let isRestored = false;
    if (!modified.has(index)) {
      try {
        xfs.renameSync(treePath, ppath.join(project.cwd, folder));
        isRestored = true;
      } catch {}
    }

    if (isRestored) {
      restored.add(folder);
      // Only the manifest remains
      try {
        xfs.unlinkSync(ppath.join(claimPath, MANIFEST_FILE));
        xfs.rmdirSync(claimPath);
      } catch {}
    } else {
      // The whole tree has to go, which we don't wait for
      remove.push(claimPath);
    }
  }

  if (remove.length > 0)
    runSpareTreeHelper({remove});

  if (restored.size > 0)
    restoredFolders.set(project, new Set([...getRestoredFolders(project), ...restored]));

  return restored;
}

/**
 * Returns the trees (by index) that contain a file which isn't the one their
 * manifest recorded anymore. Kept self-contained, as it also runs in worker
 * threads from its source.
 */
function findModifiedTrees(roots: Array<string>, entries: Array<[number, string]>, fs: typeof import('fs')) {
  const modified = new Set<number>();

  for (const [index, line] of entries) {
    if (modified.has(index))
      continue;

    const separator = line.indexOf(`\t`);
    const [ino, size, mtimeNs, mode] = line.slice(0, separator).split(` `);

    let stat;
    try {
      stat = fs.lstatSync(`${roots[index]}/${line.slice(separator + 1)}`, {bigint: true});
    } catch {
      modified.add(index);
      continue;
    }

    if (`${stat.ino}` !== ino || `${stat.size}` !== size || `${stat.mtimeNs}` !== mtimeNs || `${stat.mode}` !== mode) {
      modified.add(index);
    }
  }

  return [...modified];
}

async function findModifiedSpareTrees(roots: Array<string>, linesByTree: Array<Array<string>>): Promise<Set<number>> {
  const entries = linesByTree.flatMap((lines, index) => lines.map(line => [index, line] as [number, string]));
  if (entries.length < PARALLEL_VERIFICATION_THRESHOLD)
    return new Set(findModifiedTrees(roots, entries, fs));

  // Metadata lookups scale well across cores; a worker that fails (or can't start) marks all of its trees as modified
  const workerCount = Math.max(1, Math.min(4, os.availableParallelism?.() ?? os.cpus().length));
  const chunkSize = Math.ceil(entries.length / workerCount);
  const workerSource = `const {parentPort, workerData} = require('worker_threads');\nparentPort.postMessage((${findModifiedTrees.toString()})(workerData.roots, workerData.entries, require('fs')));`;

  const results = await Promise.all(Array.from({length: workerCount}, (_, workerIndex) => new Promise<Array<number>>(resolve => {
    const chunk = entries.slice(workerIndex * chunkSize, (workerIndex + 1) * chunkSize);
    const chunkTrees = [...new Set(chunk.map(([index]) => index))];

    try {
      const worker = new Worker(workerSource, {eval: true, workerData: {roots, entries: chunk}});
      worker.once(`message`, resolve);
      worker.once(`error`, () => resolve(chunkTrees));
      worker.once(`exit`, () => resolve(chunkTrees));
    } catch {
      resolve(chunkTrees);
    }
  })));

  return new Set(results.flat());
}

/**
 * Called once the install is fully done (including the builds). Makes new
 * spare trees in the background for the folders that this install created
 * from scratch, and discards the spare trees of the other folders if they
 * don't match the install state anymore.
 */
export async function refreshSpareTrees(project: Project, {freshFolders, builtLocations}: SpareTreeInstall) {
  const spareTreeStore = getSpareTreeStore(project.configuration);
  const installStateHash = await getInstallStateHash(project);
  const fresh = new Set(freshFolders);

  const remove: Array<PortablePath> = [];
  const refill: Array<SpareTreeRefill> = [];

  for (const folder of getNodeModulesFolders(project)) {
    const spareTreePath = getSpareTreePath(project, folder);

    // An install that didn't change anything (same install state) leaves the spare tree of an existing folder valid
    if (!fresh.has(folder)) {
      const manifest = readSpareTreeManifest(spareTreePath, {full: false});
      if (manifest === null || manifest.meta.installStateHash === installStateHash) {
        continue;
      }
    }

    if (xfs.existsSync(spareTreePath)) {
      const trashPath = `${spareTreePath}.${getUniqueSuffix()}.trash` as PortablePath;
      if (await xfs.renamePromise(spareTreePath, trashPath).then(() => true, () => false)) {
        remove.push(trashPath);
      }
    }

    if (fresh.has(folder) && installStateHash !== null && xfs.existsSync(ppath.join(project.cwd, folder))) {
      refill.push({
        folder,
        spareTree: npath.fromPortablePath(spareTreePath),
        tempPath: npath.fromPortablePath(`${spareTreePath}.${getUniqueSuffix()}.tmp` as PortablePath),
      });
    }
  }

  const fenceNs = refill.length > 0
    ? await makeFence(spareTreeStore)
    : null;

  // Without a fence (no folder to copy, or timestamps too coarse to tell what was written after the install), we only clean up
  if (fenceNs === null || installStateHash === null) {
    if (remove.length > 0)
      runSpareTreeHelper({remove, store: spareTreeStore});

    return;
  }

  runSpareTreeHelper({
    remove,
    store: spareTreeStore,
    refill: {
      projectCwd: npath.fromPortablePath(project.cwd),
      folders: refill,
      fenceNs: `${fenceNs}`,
      meta: {
        version: SPARE_TREE_VERSION,
        cwd: project.cwd,
        nmMode: project.configuration.get(`nmMode`),
        installStateHash,
      },
      keptDotEntries: KEPT_DOT_ENTRIES,
      copiedEntries: COPIED_ENTRIES,
      skippedEntries: builtLocations,
    },
  });
}

/**
 * The fence gets its mtime from the same (coarse) clock as the files. We wait
 * for that clock to tick once, so that everything written before this point is
 * strictly older than the fence, and anything at or past it was written after.
 */
async function makeFence(spareTreeStore: PortablePath): Promise<bigint | null> {
  await xfs.mkdirPromise(spareTreeStore, {recursive: true});
  const fencePath = ppath.join(spareTreeStore, `${getUniqueSuffix()}.fence` as Filename);

  const touchFence = async (iteration: number) => {
    await xfs.writeFilePromise(fencePath, `${iteration}`);
    return (await xfs.statPromise(fencePath, {bigint: true})).mtimeNs;
  };

  try {
    const start = Date.now();
    const initialNs = await touchFence(0);

    for (let iteration = 1; Date.now() - start < FENCE_TIMEOUT_MS; ++iteration) {
      await new Promise(resolve => setTimeout(resolve, 1));
      const currentNs = await touchFence(iteration);
      if (currentNs > initialNs) {
        return currentNs;
      }
    }

    return null;
  } finally {
    await xfs.removePromise(fencePath).catch(() => {});
  }
}

type SpareTreeRefill = {
  folder: PortablePath;
  spareTree: string;
  tempPath: string;
};

type SpareTreeHelperArgs = {
  remove: Array<PortablePath>;
  store?: PortablePath;
  refill?: {
    projectCwd: string;
    folders: Array<SpareTreeRefill>;
    fenceNs: string;
    meta: Omit<SpareTreeMeta, `folder`>;
    keptDotEntries: Array<string>;
    copiedEntries: Array<string>;
    skippedEntries: Array<string>;
  };
};

/**
 * Runs in a detached process (so that the install doesn't wait for it), from
 * its source code: it must be self-contained, and only use its arguments.
 */
function spareTreeHelper(args: SpareTreeHelperArgs, fs: typeof import('fs'), path: typeof import('path'), os: typeof import('os')) {
  try {
    os.setPriority(19);
  } catch {}

  const remove = (target: string) => {
    try {
      fs.rmSync(target, {recursive: true, force: true});
    } catch {}
  };

  for (const target of args.remove)
    remove(target);

  if (args.refill) {
    const {projectCwd, folders, fenceNs, meta, keptDotEntries, copiedEntries, skippedEntries} = args.refill;
    const fence = BigInt(fenceNs);
    const skipped = new Set(skippedEntries);

    for (const {folder, spareTree, tempPath} of folders) {
      const lines: Array<string> = [];
      const dirTimes: Array<[string, Date, Date]> = [];

      const copyDir = (src: string, dst: string, rel: string) => {
        const isFolderRoot = rel === ``;
        const isProjectRoot = isFolderRoot && folder === `node_modules`;

        const dirStat = fs.lstatSync(src, {bigint: true});
        if (!isFolderRoot && dirStat.mtimeNs >= fence)
          throw new Error(`Modified after the install: ${src}`);

        fs.mkdirSync(dst);

        // A directory missing some of the entries listed in the install state must look modified, so that Yarn rescans it
        let hasSkippedEntries = false;

        for (const name of fs.readdirSync(src)) {
          if (isFolderRoot && name.startsWith(`.`) && !keptDotEntries.includes(name))
            continue;

          const srcPath = path.join(src, name);
          const dstPath = path.join(dst, name);
          const relPath = isFolderRoot ? name : `${rel}/${name}`;

          if (skipped.has(`${folder}/${relPath}`)) {
            hasSkippedEntries = true;
            continue;
          }

          const stat = fs.lstatSync(srcPath, {bigint: true});
          if (stat.isDirectory()) {
            copyDir(srcPath, dstPath, relPath);
            continue;
          }

          if (stat.mtimeNs >= fence)
            throw new Error(`Modified after the install: ${srcPath}`);

          if (stat.isSymbolicLink()) {
            fs.symlinkSync(fs.readlinkSync(srcPath), dstPath);
            continue;
          }

          if (!stat.isFile())
            throw new Error(`Unsupported file type: ${srcPath}`);

          const isCopy = isProjectRoot && copiedEntries.includes(name);
          if (isCopy) {
            fs.copyFileSync(srcPath, dstPath);
            fs.utimesSync(dstPath, stat.atime, stat.mtime);
          } else {
            fs.linkSync(srcPath, dstPath);
          }

          const dstStat = fs.lstatSync(dstPath, {bigint: true});
          if (!isCopy && (dstStat.ino !== stat.ino || dstStat.mtimeNs !== stat.mtimeNs || dstStat.size !== stat.size))
            throw new Error(`Modified while being copied: ${srcPath}`);

          lines.push(`${dstStat.ino} ${dstStat.size} ${dstStat.mtimeNs} ${dstStat.mode}\t${relPath}`);
        }

        // Directories keep their timestamps (truncated to the millisecond, so never newer), as the install state relies
        // on them; children come first, so that setting them doesn't change their parent's
        const now = new Date(Date.now() + 1000);
        dirTimes.push(hasSkippedEntries ? [dst, now, now] : [dst, dirStat.atime, dirStat.mtime]);
      };

      try {
        fs.mkdirSync(tempPath);
        copyDir(path.join(projectCwd, folder), path.join(tempPath, `node_modules`), ``);

        for (const [dir, atime, mtime] of dirTimes)
          fs.utimesSync(dir, atime, mtime);

        fs.writeFileSync(path.join(tempPath, `manifest`), `${JSON.stringify({...meta, folder})}\n${lines.map(line => `${line}\n`).join(``)}`);

        // If another spare tree appeared in the meantime, we keep it rather than replace it
        fs.renameSync(tempPath, spareTree);
      } catch {
        remove(tempPath);
      }
    }
  }

  // Garbage-collect what crashed processes and deleted projects left behind
  if (args.store) {
    try {
      const now = Date.now();
      for (const name of fs.readdirSync(args.store)) {
        const entryPath = path.join(args.store, name);
        if (/\.(tmp|claim|trash|fence)$/.test(name)) {
          if (now - fs.lstatSync(entryPath).mtimeMs > 24 * 60 * 60 * 1000) {
            remove(entryPath);
          }
        } else {
          let cwd = null;
          try {
            const fd = fs.openSync(path.join(entryPath, `manifest`), `r`);
            const buffer = Buffer.alloc(16384);
            const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
            fs.closeSync(fd);
            cwd = JSON.parse(buffer.subarray(0, size).toString().split(`\n`)[0]).cwd;
          } catch {}

          if (cwd === null || !fs.existsSync(cwd)) {
            remove(entryPath);
          }
        }
      }
    } catch {}
  }
}

function runSpareTreeHelper(args: SpareTreeHelperArgs) {
  const env = {...process.env};
  delete env.NODE_OPTIONS;

  // The arguments go through a file: in large monorepos they exceed the size limit of a single command-line argument
  // (128KB on Linux), which makes spawn fail with E2BIG. The `.tmp` suffix lets the store's garbage collection remove
  // the file if the helper never gets to it
  const source = `(() => { const fs = require('fs'); const argsPath = process.argv[1]; let args; try { args = JSON.parse(fs.readFileSync(argsPath, 'utf8')); } finally { try { fs.unlinkSync(argsPath); } catch {} } (${spareTreeHelper.toString()})(args, fs, require('path'), require('os')); })()`;

  try {
    const argsDir = typeof args.store !== `undefined` ? npath.fromPortablePath(args.store) : os.tmpdir();
    const argsPath = `${argsDir}/${getUniqueSuffix()}.args.tmp`;
    fs.mkdirSync(argsDir, {recursive: true});
    fs.writeFileSync(argsPath, JSON.stringify(args));

    const child = spawn(process.execPath, [`-e`, source, argsPath], {
      detached: true,
      stdio: `ignore`,
      windowsHide: true,
      env,
    });

    child.on(`error`, () => {});
    child.unref();
  } catch {}
}
