import {Filename, PortablePath, ppath, xfs} from '@yarnpkg/fslib';

const {
  tests: {testIf},
} = require(`pkg-tests-core`);

const SPARE_TREE_CONFIG = {
  nodeLinker: `node-modules`,
  nmMode: `hardlinks-global`,
};

const CONTAINER_REGEXP = /^[0-9a-f]{32}$/;
const PENDING_REGEXP = /\.(tmp|trash|claim|fence)$/;

const getSpareTreeStore = (path: PortablePath) => ppath.join(path, `.yarn/global/nm-spare` as PortablePath);

/**
 * Spare trees are made by a detached process once the install is done, so we
 * wait until it either produced them or gave up. Returns the spare trees by
 * node_modules folder (relative to the project).
 */
async function waitForSpareTrees(path: PortablePath) {
  const store = getSpareTreeStore(path);

  let sawPending = false;
  const start = Date.now();

  while (Date.now() - start < 15000) {
    const entries = await xfs.readdirPromise(store).catch(() => [] as Array<Filename>);
    const isPending = entries.some(entry => PENDING_REGEXP.test(entry));
    sawPending ||= isPending;

    const containers = entries.filter(entry => CONTAINER_REGEXP.test(entry) && xfs.existsSync(ppath.join(store, entry, `manifest` as Filename)));
    if (!isPending && (containers.length > 0 || sawPending || Date.now() - start > 3000)) {
      const spareTrees = new Map<string, PortablePath>();
      for (const container of containers) {
        const manifest = await xfs.readFilePromise(ppath.join(store, container, `manifest` as Filename), `utf8`);
        spareTrees.set(JSON.parse(manifest.split(`\n`)[0]).folder, ppath.join(store, container, Filename.nodeModules));
      }
      return spareTrees;
    }

    await new Promise(resolve => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for the spare trees`);
}

// The spare tree of the root node_modules folder
async function waitForSpareTree(path: PortablePath) {
  return (await waitForSpareTrees(path)).get(`node_modules`) ?? null;
}

async function getInode(p: PortablePath) {
  return (await xfs.lstatPromise(p)).ino;
}

describe(`Features`, () => {
  describe(`nmSpareTree`, () => {
    testIf(() => process.platform !== `win32`, `it should restore node_modules from the spare tree`,
      makeTemporaryEnv({
        dependencies: {
          [`one-fixed-dep`]: `1.0.0`,
          [`has-bin-entries`]: `1.0.0`,
        },
      }, SPARE_TREE_CONFIG, async ({path, run, source}) => {
        await run(`install`);

        const spareTree = await waitForSpareTree(path);
        expect(spareTree).not.toBeNull();
        const spareTreeInode = await getInode(spareTree!);

        await xfs.removePromise(ppath.join(path, Filename.nodeModules));
        await run(`install`);

        expect(await getInode(ppath.join(path, Filename.nodeModules))).toEqual(spareTreeInode);

        await expect(source(`require('one-fixed-dep')`)).resolves.toMatchObject({
          name: `one-fixed-dep`,
          dependencies: {[`no-deps`]: {name: `no-deps`, version: `1.0.0`}},
        });

        expect(xfs.existsSync(ppath.join(path, `node_modules/.bin/has-bin-entries` as PortablePath))).toEqual(true);

        // The restored tree is refilled for the next time
        expect(await waitForSpareTree(path)).not.toBeNull();
      }),
    );

    testIf(() => process.platform !== `win32`, `it should restore the node_modules folders of every workspace`,
      makeTemporaryEnv({
        private: true,
        workspaces: [`packages/*`],
        dependencies: {[`no-deps`]: `1.0.0`},
      }, SPARE_TREE_CONFIG, async ({path, run, source}) => {
        // The workspace needs another version than the root, so it gets its own node_modules folder
        await xfs.mkdirPromise(ppath.join(path, `packages/a` as PortablePath), {recursive: true});
        await xfs.writeJsonPromise(ppath.join(path, `packages/a/package.json` as PortablePath), {name: `a`, dependencies: {[`no-deps`]: `2.0.0`}});

        await run(`install`);

        const spareTrees = await waitForSpareTrees(path);
        expect(spareTrees.has(`node_modules`)).toEqual(true);
        expect(spareTrees.has(`packages/a/node_modules`)).toEqual(true);
        const workspaceSpareTreeInode = await getInode(spareTrees.get(`packages/a/node_modules`)!);

        await xfs.removePromise(ppath.join(path, Filename.nodeModules));
        await xfs.removePromise(ppath.join(path, `packages/a/node_modules` as PortablePath));
        await run(`install`);

        expect(await getInode(ppath.join(path, `packages/a/node_modules` as PortablePath))).toEqual(workspaceSpareTreeInode);
        await expect(source(`require('no-deps')`)).resolves.toMatchObject({version: `1.0.0`});
        await expect(source(`require('no-deps')`, {cwd: ppath.join(path, `packages/a` as PortablePath)})).resolves.toMatchObject({version: `2.0.0`});
      }),
    );

    testIf(() => process.platform !== `win32`, `it should skip the whole install when the restored tree is up to date`,
      makeTemporaryEnv({
        dependencies: {[`one-fixed-dep`]: `1.0.0`},
      }, {
        ...SPARE_TREE_CONFIG,
        enableGlobalCache: true,
      }, async ({path, run, source}) => {
        await run(`install`);
        expect(await waitForSpareTree(path)).not.toBeNull();

        await xfs.removePromise(ppath.join(path, Filename.nodeModules));
        const {stdout} = await run(`install`);

        expect(stdout).toMatch(/Already up to date/);
        await expect(source(`require('one-fixed-dep')`)).resolves.toMatchObject({
          dependencies: {[`no-deps`]: {name: `no-deps`, version: `1.0.0`}},
        });

        // The restored tree is refilled for the next time
        expect(await waitForSpareTree(path)).not.toBeNull();
      }),
    );

    testIf(() => process.platform !== `win32`, `it should give the same node_modules as a regular install`,
      makeTemporaryEnv({
        dependencies: {
          [`one-fixed-dep`]: `1.0.0`,
          [`no-deps`]: `2.0.0`,
          [`has-bin-entries`]: `1.0.0`,
        },
      }, SPARE_TREE_CONFIG, async ({path, run}) => {
        const listTree = async () => {
          const entries: Array<string> = [];
          const walk = async (p: PortablePath, rel: string) => {
            for (const name of (await xfs.readdirPromise(p)).sort()) {
              const entryPath = ppath.join(p, name);
              const relPath = `${rel}/${name}`;
              const stat = await xfs.lstatPromise(entryPath);
              if (stat.isDirectory()) {
                entries.push(`${relPath}/ ${stat.mode}`);
                await walk(entryPath, relPath);
              } else if (stat.isSymbolicLink()) {
                entries.push(`${relPath} -> ${await xfs.readlinkPromise(entryPath)}`);
              } else if (name !== `.yarn-state.yml`) {
                entries.push(`${relPath} ${stat.mode} ${await xfs.readFilePromise(entryPath, `utf8`)}`);
              }
            }
          };

          await walk(ppath.join(path, Filename.nodeModules), ``);
          return entries;
        };

        await run(`install`, {env: {YARN_NM_SPARE_TREE: `false`}});
        const regularTree = await listTree();

        await xfs.removePromise(ppath.join(path, Filename.nodeModules));
        await run(`install`);
        expect(await waitForSpareTree(path)).not.toBeNull();

        await xfs.removePromise(ppath.join(path, Filename.nodeModules));
        await run(`install`);

        expect(await listTree()).toEqual(regularTree);
      }),
    );

    testIf(() => process.platform !== `win32`, `it should not restore a spare tree whose files were modified through node_modules`,
      makeTemporaryEnv({
        dependencies: {
          [`no-deps`]: `1.0.0`,
        },
      }, SPARE_TREE_CONFIG, async ({path, run}) => {
        await run(`install`);

        const spareTree = await waitForSpareTree(path);
        expect(spareTree).not.toBeNull();
        const spareTreeInode = await getInode(spareTree!);

        const indexPath = ppath.join(path, `node_modules/no-deps/index.js` as PortablePath);
        const originalContent = await xfs.readFilePromise(indexPath, `utf8`);
        await xfs.appendFilePromise(indexPath, `\n// modified\n`);

        await xfs.removePromise(ppath.join(path, Filename.nodeModules));
        await run(`install`);

        expect(await getInode(ppath.join(path, Filename.nodeModules))).not.toEqual(spareTreeInode);
        expect(await xfs.readFilePromise(indexPath, `utf8`)).toEqual(originalContent);
      }),
    );

    testIf(() => process.platform !== `win32`, `it should not restore a spare tree whose files had their mode changed`,
      makeTemporaryEnv({
        dependencies: {
          [`no-deps`]: `1.0.0`,
        },
      }, SPARE_TREE_CONFIG, async ({path, run}) => {
        await run(`install`);

        const spareTree = await waitForSpareTree(path);
        expect(spareTree).not.toBeNull();
        const spareTreeInode = await getInode(spareTree!);

        await xfs.chmodPromise(ppath.join(path, `node_modules/no-deps/index.js` as PortablePath), 0o755);

        await xfs.removePromise(ppath.join(path, Filename.nodeModules));
        await run(`install`);

        expect(await getInode(ppath.join(path, Filename.nodeModules))).not.toEqual(spareTreeInode);
      }),
    );

    testIf(() => process.platform !== `win32`, `it should not keep files written to node_modules after the install`,
      makeTemporaryEnv({
        dependencies: {
          [`no-deps`]: `1.0.0`,
        },
      }, SPARE_TREE_CONFIG, async ({path, run}) => {
        await run(`install`);

        // Tools such as bundlers write caches into node_modules right after the install
        await xfs.mkdirPromise(ppath.join(path, `node_modules/.cache` as PortablePath));
        await xfs.writeFilePromise(ppath.join(path, `node_modules/.cache/data` as PortablePath), `cache`);
        await xfs.writeFilePromise(ppath.join(path, `node_modules/no-deps/extra.js` as PortablePath), `extra`);

        await waitForSpareTree(path);

        await xfs.removePromise(ppath.join(path, Filename.nodeModules));
        await run(`install`);

        expect(xfs.existsSync(ppath.join(path, `node_modules/.cache` as PortablePath))).toEqual(false);
        expect(xfs.existsSync(ppath.join(path, `node_modules/no-deps/extra.js` as PortablePath))).toEqual(false);
        expect(xfs.existsSync(ppath.join(path, `node_modules/no-deps/index.js` as PortablePath))).toEqual(true);
      }),
    );

    testIf(() => process.platform !== `win32`, `it should not make a spare tree out of a node_modules that already existed`,
      makeTemporaryEnv({
        dependencies: {
          [`no-deps`]: `1.0.0`,
        },
      }, SPARE_TREE_CONFIG, async ({path, run}) => {
        await run(`install`);
        expect(await waitForSpareTree(path)).not.toBeNull();

        // A file only present in the existing node_modules, which an incremental install doesn't remove
        await xfs.writeFilePromise(ppath.join(path, `node_modules/no-deps/stray.js` as PortablePath), `stray`);

        await xfs.writeJsonPromise(ppath.join(path, Filename.manifest), {
          dependencies: {
            [`no-deps`]: `1.0.0`,
            [`one-fixed-dep`]: `1.0.0`,
          },
        });

        await run(`install`);

        // The previous spare tree doesn't match the new install, and none is made from the existing node_modules
        expect(await waitForSpareTree(path)).toBeNull();

        await xfs.removePromise(ppath.join(path, Filename.nodeModules));
        await run(`install`);

        expect(xfs.existsSync(ppath.join(path, `node_modules/no-deps/stray.js` as PortablePath))).toEqual(false);
        expect(xfs.existsSync(ppath.join(path, `node_modules/one-fixed-dep/package.json` as PortablePath))).toEqual(true);
      }),
    );

    testIf(() => process.platform !== `win32`, `it should apply the changes made to the project since the spare tree was made`,
      makeTemporaryEnv({
        dependencies: {
          [`no-deps`]: `1.0.0`,
          [`has-bin-entries`]: `1.0.0`,
        },
      }, SPARE_TREE_CONFIG, async ({path, run, source}) => {
        await run(`install`);

        const spareTree = await waitForSpareTree(path);
        expect(spareTree).not.toBeNull();
        const spareTreeInode = await getInode(spareTree!);

        await xfs.writeJsonPromise(ppath.join(path, Filename.manifest), {
          dependencies: {
            [`no-deps`]: `2.0.0`,
            [`one-fixed-dep`]: `1.0.0`,
          },
        });

        await xfs.removePromise(ppath.join(path, Filename.nodeModules));
        await run(`install`);

        expect(await getInode(ppath.join(path, Filename.nodeModules))).toEqual(spareTreeInode);

        await expect(source(`require('no-deps')`)).resolves.toMatchObject({version: `2.0.0`});
        await expect(source(`require('one-fixed-dep')`)).resolves.toMatchObject({name: `one-fixed-dep`});
        expect(xfs.existsSync(ppath.join(path, `node_modules/has-bin-entries` as PortablePath))).toEqual(false);
        expect(xfs.existsSync(ppath.join(path, `node_modules/.bin/has-bin-entries` as PortablePath))).toEqual(false);
      }),
    );

    testIf(() => process.platform !== `win32`, `it should rebuild packages with build scripts when restoring the spare tree`,
      makeTemporaryEnv({
        dependencies: {
          [`no-deps-scripted`]: `1.0.0`,
          [`no-deps`]: `1.0.0`,
        },
      }, {
        ...SPARE_TREE_CONFIG,
        enableScripts: true,
      }, async ({path, run, source}) => {
        await run(`install`);

        const spareTree = await waitForSpareTree(path);
        expect(spareTree).not.toBeNull();
        const spareTreeInode = await getInode(spareTree!);

        // Packages that get built aren't part of the spare tree
        expect(xfs.existsSync(ppath.join(spareTree!, `no-deps-scripted` as PortablePath))).toEqual(false);
        expect(xfs.existsSync(ppath.join(spareTree!, `no-deps` as PortablePath))).toEqual(true);

        await xfs.removePromise(ppath.join(path, Filename.nodeModules));
        const {stdout} = await run(`install`);

        expect(await getInode(ppath.join(path, Filename.nodeModules))).toEqual(spareTreeInode);
        expect(stdout).toMatch(new RegExp(`no-deps-scripted@npm:1.0.0 must be built`));

        await expect(source(`require('no-deps-scripted/log.js')`)).resolves.toEqual([
          `preinstall`,
          `install`,
          `postinstall`,
        ]);
      }),
    );

    for (const nmMode of [`classic`, `hardlinks-local`]) {
      testIf(() => process.platform !== `win32`, `it should restore node_modules from the spare tree (nmMode: ${nmMode})`,
        makeTemporaryEnv({
          dependencies: {[`one-fixed-dep`]: `1.0.0`},
        }, {
          nodeLinker: `node-modules`,
          nmMode,
        }, async ({path, run, source}) => {
          await run(`install`);

          const spareTree = await waitForSpareTree(path);
          expect(spareTree).not.toBeNull();
          const spareTreeInode = await getInode(spareTree!);

          await xfs.removePromise(ppath.join(path, Filename.nodeModules));
          await run(`install`);

          expect(await getInode(ppath.join(path, Filename.nodeModules))).toEqual(spareTreeInode);
          await expect(source(`require('one-fixed-dep')`)).resolves.toMatchObject({
            dependencies: {[`no-deps`]: {name: `no-deps`, version: `1.0.0`}},
          });
        }),
      );
    }

    testIf(() => process.platform !== `win32`, `it should restore a single missing node_modules folder`,
      makeTemporaryEnv({
        private: true,
        workspaces: [`packages/*`],
        dependencies: {[`no-deps`]: `1.0.0`},
      }, SPARE_TREE_CONFIG, async ({path, run, source}) => {
        await xfs.mkdirPromise(ppath.join(path, `packages/a` as PortablePath), {recursive: true});
        await xfs.writeJsonPromise(ppath.join(path, `packages/a/package.json` as PortablePath), {name: `a`, dependencies: {[`no-deps`]: `2.0.0`}});

        await run(`install`);

        const spareTree = await waitForSpareTree(path);
        expect(spareTree).not.toBeNull();
        const workspaceFolderInode = await getInode(ppath.join(path, `packages/a/node_modules` as PortablePath));

        // Only the root folder is removed, which is the common case
        await xfs.removePromise(ppath.join(path, Filename.nodeModules));
        await run(`install`);

        expect(await getInode(ppath.join(path, `packages/a/node_modules` as PortablePath))).toEqual(workspaceFolderInode);
        await expect(source(`require('no-deps')`)).resolves.toMatchObject({version: `1.0.0`});
        await expect(source(`require('no-deps')`, {cwd: ppath.join(path, `packages/a` as PortablePath)})).resolves.toMatchObject({version: `2.0.0`});

        // A new spare tree is made for the restored folder, so this works again
        await waitForSpareTree(path);
        await xfs.removePromise(ppath.join(path, Filename.nodeModules));
        await run(`install`);
        await expect(source(`require('no-deps')`)).resolves.toMatchObject({version: `1.0.0`});
      }),
    );

    test(`it should be off on CI unless enabled explicitly`,
      makeTemporaryEnv({
        dependencies: {[`no-deps`]: `1.0.0`},
      }, SPARE_TREE_CONFIG, async ({path, run}) => {
        await run(`install`, {env: {CI: `true`, YARN_ENABLE_IMMUTABLE_INSTALLS: `false`}});
        await xfs.removePromise(ppath.join(path, Filename.nodeModules));
        await run(`install`, {env: {CI: `true`, YARN_ENABLE_IMMUTABLE_INSTALLS: `false`}});

        expect(await waitForSpareTree(path)).toBeNull();
        expect(xfs.existsSync(getSpareTreeStore(path))).toEqual(false);

        await run(`install`, {env: {CI: `true`, YARN_ENABLE_IMMUTABLE_INSTALLS: `false`, YARN_NM_SPARE_TREE: `true`}});
        expect(await waitForSpareTree(path)).toBeNull();

        await xfs.removePromise(ppath.join(path, Filename.nodeModules));
        await run(`install`, {env: {CI: `true`, YARN_ENABLE_IMMUTABLE_INSTALLS: `false`, YARN_NM_SPARE_TREE: `true`}});
        expect(await waitForSpareTree(path)).not.toBeNull();
      }),
    );

    test(`it should not be used when nmSpareTree is disabled`,
      makeTemporaryEnv({
        dependencies: {
          [`no-deps`]: `1.0.0`,
        },
      }, {
        ...SPARE_TREE_CONFIG,
        nmSpareTree: false,
      }, async ({path, run}) => {
        await run(`install`);
        await xfs.removePromise(ppath.join(path, Filename.nodeModules));
        await run(`install`);

        expect(await waitForSpareTree(path)).toBeNull();
        expect(xfs.existsSync(getSpareTreeStore(path))).toEqual(false);
      }),
    );

    testIf(() => process.platform !== `win32`, `it should be removed by yarn cache clean --all`,
      makeTemporaryEnv({
        dependencies: {
          [`no-deps`]: `1.0.0`,
        },
      }, SPARE_TREE_CONFIG, async ({path, run}) => {
        await run(`install`);
        expect(await waitForSpareTree(path)).not.toBeNull();

        await run(`cache`, `clean`, `--all`);

        expect(xfs.existsSync(getSpareTreeStore(path))).toEqual(false);
      }),
    );
  });
});
