import {Filename, PortablePath, ppath, xfs} from '@yarnpkg/fslib';

const UP_TO_DATE = /Already up to date/;
const RESOLUTION_STEP = /Resolution step/;

// The test environment uses a local cache by default, which isn't eligible
const CONFIG = {
  nodeLinker: `node-modules`,
  enableGlobalCache: true,
};

const getCacheArchives = async (path: PortablePath) => {
  const cacheFolder = ppath.join(path, `.yarn/global/cache` as PortablePath);
  return (await xfs.readdirPromise(cacheFolder)).filter(entry => entry.endsWith(`.zip`)).map(entry => ppath.join(cacheFolder, entry));
};

describe(`Features`, () => {
  describe(`Up-to-date installs`, () => {
    test(`it should skip an install when nothing changed since the last one`,
      makeTemporaryEnv({
        dependencies: {[`one-fixed-dep`]: `1.0.0`},
      }, CONFIG, async ({path, run, source}) => {
        await run(`install`);

        const {stdout} = await run(`install`);
        expect(stdout).toMatch(UP_TO_DATE);
        expect(stdout).not.toMatch(RESOLUTION_STEP);

        await expect(source(`require('one-fixed-dep')`)).resolves.toMatchObject({name: `one-fixed-dep`});
      }),
    );

    test(`it should skip an install started from a workspace`,
      makeTemporaryEnv({
        private: true,
        workspaces: [`packages/*`],
      }, CONFIG, async ({path, run}) => {
        await xfs.mkdirPromise(ppath.join(path, `packages/a` as PortablePath), {recursive: true});
        await xfs.writeJsonPromise(ppath.join(path, `packages/a/package.json` as PortablePath), {name: `a`, dependencies: {[`no-deps`]: `1.0.0`}});

        await run(`install`);

        const {stdout} = await run(`install`, {cwd: ppath.join(path, `packages/a` as PortablePath)});
        expect(stdout).toMatch(UP_TO_DATE);
      }),
    );

    test(`it should not skip an install when the lockfile changed`,
      makeTemporaryEnv({
        dependencies: {[`no-deps`]: `1.0.0`},
      }, CONFIG, async ({path, run}) => {
        await run(`install`);

        await xfs.writeFilePromise(ppath.join(path, Filename.lockfile), `${await xfs.readFilePromise(ppath.join(path, Filename.lockfile), `utf8`)}\n`);

        const {stdout} = await run(`install`);
        expect(stdout).not.toMatch(UP_TO_DATE);
      }),
    );

    test(`it should not skip an install when a manifest changed`,
      makeTemporaryEnv({
        dependencies: {[`no-deps`]: `1.0.0`},
      }, CONFIG, async ({path, run, source}) => {
        await run(`install`);

        await xfs.writeJsonPromise(ppath.join(path, Filename.manifest), {dependencies: {[`no-deps`]: `2.0.0`}});

        const {stdout} = await run(`install`);
        expect(stdout).not.toMatch(UP_TO_DATE);

        await expect(source(`require('no-deps')`)).resolves.toMatchObject({version: `2.0.0`});
      }),
    );

    test(`it should not skip an install when the configuration changed`,
      makeTemporaryEnv({
        dependencies: {[`no-deps`]: `1.0.0`},
      }, CONFIG, async ({path, run}) => {
        await run(`install`);

        const {stdout} = await run(`install`, {env: {YARN_NM_HOISTING_LIMITS: `workspaces`}});
        expect(stdout).not.toMatch(UP_TO_DATE);
      }),
    );

    test(`it should not skip an install when a package was removed from node_modules`,
      makeTemporaryEnv({
        dependencies: {[`one-fixed-dep`]: `1.0.0`},
      }, CONFIG, async ({path, run, source}) => {
        await run(`install`);

        await xfs.removePromise(ppath.join(path, `node_modules/no-deps` as PortablePath));

        const {stdout} = await run(`install`);
        expect(stdout).not.toMatch(UP_TO_DATE);

        await expect(source(`require('one-fixed-dep')`)).resolves.toMatchObject({
          dependencies: {[`no-deps`]: {name: `no-deps`}},
        });
      }),
    );

    test(`it should not skip an install when a binary target appeared or disappeared`,
      makeTemporaryEnv({
        name: `pkg`,
        bin: `dist/bin/index.js`,
      }, CONFIG, async ({path, run}) => {
        const binTarget = ppath.join(path, `dist/bin/index.js` as PortablePath);
        const binLink = ppath.join(path, `node_modules/.bin/pkg` as PortablePath);

        await run(`install`);
        expect(xfs.existsSync(binLink)).toEqual(false);

        // Typically built after the install
        await xfs.mkdirPromise(ppath.dirname(binTarget), {recursive: true});
        await xfs.writeFilePromise(binTarget, ``);

        await expect(run(`install`)).resolves.toMatchObject({stdout: expect.not.stringMatching(UP_TO_DATE)});
        expect(xfs.existsSync(binLink)).toEqual(true);
        await expect(run(`install`)).resolves.toMatchObject({stdout: expect.stringMatching(UP_TO_DATE)});

        await xfs.removePromise(binTarget);
        await expect(run(`install`)).resolves.toMatchObject({stdout: expect.not.stringMatching(UP_TO_DATE)});
      }),
    );

    test(`it should not skip an install when node_modules is missing`,
      makeTemporaryEnv({
        dependencies: {[`no-deps`]: `1.0.0`},
      }, {
        ...CONFIG,
        nmSpareTree: false,
      }, async ({path, run, source}) => {
        await run(`install`);

        await xfs.removePromise(ppath.join(path, Filename.nodeModules));

        const {stdout} = await run(`install`);
        expect(stdout).not.toMatch(UP_TO_DATE);

        await expect(source(`require('no-deps')`)).resolves.toMatchObject({name: `no-deps`});
      }),
    );

    test(`it should not skip an install when a cache archive is missing`,
      makeTemporaryEnv({
        dependencies: {[`no-deps`]: `1.0.0`},
      }, CONFIG, async ({path, run}) => {
        await run(`install`);

        const archives = await getCacheArchives(path);
        expect(archives).toHaveLength(1);
        await xfs.removePromise(archives[0]);

        const {stdout} = await run(`install`);
        expect(stdout).not.toMatch(UP_TO_DATE);

        expect(xfs.existsSync(archives[0])).toEqual(true);
      }),
    );

    test(`it should not skip an install while a build still has to succeed`,
      makeTemporaryEnv({
        dependencies: {[`no-deps-scripted-to-fail`]: `1.0.0`},
      }, {
        ...CONFIG,
        enableScripts: true,
      }, async ({path, run}) => {
        await expect(run(`install`)).rejects.toThrow(/couldn't be built successfully/);

        // A regular install would try the build again, and so must this one
        await expect(run(`install`)).rejects.toThrow(/couldn't be built successfully/);
      }),
    );

    test(`it should skip an install once the builds succeeded`,
      makeTemporaryEnv({
        dependencies: {[`no-deps-scripted`]: `1.0.0`},
      }, {
        ...CONFIG,
        enableScripts: true,
      }, async ({path, run, source}) => {
        await run(`install`);

        const {stdout} = await run(`install`);
        expect(stdout).toMatch(UP_TO_DATE);

        await expect(source(`require('no-deps-scripted/log.js')`)).resolves.toEqual([`preinstall`, `install`, `postinstall`]);
      }),
    );

    test(`it should still run the post-install validation when nothing changed`,
      makeTemporaryEnv({
        dependencies: {[`no-deps`]: `1.0.0`},
      }, {
        ...CONFIG,
        enableConstraintsChecks: true,
      }, async ({path, run}) => {
        await run(`install`);
        await expect(run(`install`)).resolves.toMatchObject({stdout: expect.stringMatching(UP_TO_DATE)});

        // Constraints aren't install inputs, but they're checked after every install
        await xfs.writeFilePromise(ppath.join(path, `yarn.config.cjs` as PortablePath), `exports.constraints = ({Yarn}) => {\n  for (const workspace of Yarn.workspaces())\n    workspace.set('foo', 'bar');\n};\n`);
        await expect(run(`install`)).rejects.toThrow(/Constraint check failed/);
      }),
    );

    test(`it should not skip installs that ask for extra checks`,
      makeTemporaryEnv({
        dependencies: {[`no-deps`]: `1.0.0`},
      }, CONFIG, async ({path, run}) => {
        await run(`install`);

        for (const flag of [`--check-cache`, `--check-resolutions`, `--refresh-lockfile`, `--mode=skip-build`]) {
          const {stdout} = await run(`install`, flag);
          expect(stdout).not.toMatch(UP_TO_DATE);
        }

        // After --mode=skip-build, a regular install still has to run the builds, after which the next one is skipped
        await run(`install`);
        await expect(run(`install`)).resolves.toMatchObject({stdout: expect.stringMatching(UP_TO_DATE)});
      }),
    );

    test(`it should not skip installs of projects using a local cache`,
      makeTemporaryEnv({
        dependencies: {[`no-deps`]: `1.0.0`},
      }, {
        nodeLinker: `node-modules`,
        enableGlobalCache: false,
      }, async ({path, run}) => {
        await run(`install`);

        const {stdout} = await run(`install`);
        expect(stdout).not.toMatch(UP_TO_DATE);
      }),
    );

    test(`it should not skip installs with the pnp linker`,
      makeTemporaryEnv({
        dependencies: {[`no-deps`]: `1.0.0`},
      }, {
        nodeLinker: `pnp`,
        enableGlobalCache: true,
      }, async ({path, run}) => {
        await run(`install`);

        const {stdout} = await run(`install`);
        expect(stdout).not.toMatch(UP_TO_DATE);
      }),
    );

    test(`it should not skip installs of projects with file dependencies`,
      makeTemporaryEnv({
        dependencies: {[`dep`]: `file:./dep`},
      }, CONFIG, async ({path, run, source}) => {
        await xfs.mkdirPromise(ppath.join(path, `dep` as PortablePath));
        await xfs.writeJsonPromise(ppath.join(path, `dep/package.json` as PortablePath), {name: `dep`, version: `1.0.0`});
        await xfs.writeFilePromise(ppath.join(path, `dep/index.js` as PortablePath), `module.exports = 1;\n`);

        await run(`install`);

        await xfs.writeFilePromise(ppath.join(path, `dep/index.js` as PortablePath), `module.exports = 2;\n`);

        const {stdout} = await run(`install`);
        expect(stdout).not.toMatch(UP_TO_DATE);

        await expect(source(`require('dep')`)).resolves.toEqual(2);
      }),
    );
  });
});
