// Generates a synthetic, very large monorepo using real npm packages, to
// benchmark warm installs (lockfile + cache already present).
//
// Usage:
//   node scripts/benchmarks/gen-large-monorepo.mjs <out-dir> [workspace-count=1000]
//   cd <out-dir> && yarn install          # cold, populates the lockfile & cache
//   time yarn install                     # warm
//
// The dependencies are picked from a list of popular npm packages, each with
// several ranges spread across their last few majors, so that the resulting
// lockfile contains many descriptors per package (~10k packages and ~30k
// descriptors with the default settings). The output depends on what's
// currently published on the registry, so it isn't strictly reproducible.

import fs   from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
if (!OUT)
  throw new Error(`Usage: gen-large-monorepo.mjs <out-dir> [workspace-count]`);

const N_WS = Number(process.argv[3] ?? 1000);

// Note: packages shipping very large archives (next, electron, parcel, prisma,
// aws-sdk v2, ...) are deliberately left out; with ~10GB of archives the PnP
// linker runs out of libzip (wasm) memory, which is a separate issue.
const SEEDS = `
react react-dom react-redux redux @reduxjs/toolkit react-router react-router-dom vue @vue/compiler-sfc nuxt svelte @sveltejs/kit
@angular/core @angular/common @angular/compiler @angular/cli @angular-devkit/build-angular rxjs zone.js
webpack webpack-cli webpack-dev-server html-webpack-plugin css-loader style-loader sass-loader sass less postcss autoprefixer tailwindcss
babel-loader @babel/core @babel/preset-env @babel/preset-react @babel/preset-typescript @babel/runtime @babel/plugin-transform-runtime core-js
typescript ts-node ts-jest @types/node @types/react @types/lodash @types/jest tslib
jest jest-environment-jsdom @testing-library/react @testing-library/jest-dom mocha chai sinon vitest cypress playwright @playwright/test puppeteer karma
eslint eslint-plugin-react eslint-plugin-import @typescript-eslint/parser @typescript-eslint/eslint-plugin prettier eslint-config-prettier stylelint
rollup @rollup/plugin-node-resolve @rollup/plugin-commonjs vite @vitejs/plugin-react esbuild terser uglify-js
lodash lodash-es underscore ramda moment dayjs date-fns luxon axios node-fetch got request superagent
express koa fastify hapi @hapi/hapi body-parser cors helmet morgan cookie-parser express-session passport
mongoose sequelize typeorm pg mysql2 redis ioredis knex sqlite3
@aws-sdk/client-s3 @aws-sdk/client-dynamodb @aws-sdk/client-lambda @aws-sdk/client-sqs @aws-sdk/client-sns
@google-cloud/storage @azure/storage-blob
graphql apollo-server @apollo/client graphql-tag type-graphql
socket.io socket.io-client ws uuid nanoid chalk commander yargs inquirer ora debug minimist glob rimraf mkdirp fs-extra chokidar
@mui/material @emotion/react @emotion/styled styled-components @chakra-ui/react bootstrap react-bootstrap
storybook @storybook/react @storybook/addon-essentials @storybook/addon-links
three d3 chart.js leaflet
@nestjs/core @nestjs/common @nestjs/platform-express class-validator class-transformer reflect-metadata
winston pino bunyan dotenv cross-env concurrently nodemon pm2 husky lint-staged semver
jsonwebtoken bcrypt bcryptjs crypto-js
sharp jimp canvas
lerna
zod yup joi ajv
immer mobx mobx-react zustand jotai recoil xstate
formik react-hook-form
i18next react-i18next
marked markdown-it remark rehype unified
cheerio jsdom
`.trim().split(/\s+/);

// Deterministic PRNG so that the same registry state yields the same repo
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = arr => arr[Math.floor(rand() * arr.length)];

async function fetchVersions(name) {
  const url = `https://registry.npmjs.org/${name.replace(`/`, `%2f`)}`;

  for (let t = 0; t < 4; t++) {
    try {
      const res = await fetch(url, {headers: {accept: `application/vnd.npm.install-v1+json`}});
      if (!res.ok)
        return null;

      const data = await res.json();
      return Object.keys(data.versions).filter(v => /^\d+\.\d+\.\d+$/.test(v));
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return null;
}

const compareVersions = (a, b) => {
  const x = a.split(`.`).map(Number);
  const y = b.split(`.`).map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

// For each seed, compute a set of candidate ranges: for each of the last three
// majors, a caret range on the latest version, plus a caret and a tilde range
// on an older version of the same major.
const candidates = {};

await Promise.all(SEEDS.map(async name => {
  const versions = await fetchVersions(name);
  if (!versions || versions.length === 0) {
    console.error(`skipping ${name}`);
    return;
  }

  versions.sort(compareVersions);

  const byMajor = new Map();
  for (const version of versions) {
    const major = version.split(`.`)[0];
    if (!byMajor.has(major))
      byMajor.set(major, []);

    byMajor.get(major).push(version);
  }

  const ranges = [];
  for (const major of [...byMajor.keys()].sort((a, b) => a - b).slice(-3)) {
    const majorVersions = byMajor.get(major);
    const latest = majorVersions[majorVersions.length - 1];
    const middle = majorVersions[Math.floor(majorVersions.length / 2)];

    ranges.push(`^${latest}`, `^${middle}`, `~${middle}`);
  }

  candidates[name] = [...new Set(ranges)];
}));

const names = Object.keys(candidates).sort();
console.error(`seeds: ${names.length}`);

const sortObject = obj => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a < b ? -1 : 1));
const workspaceName = index => `@crazy/pkg-${String(index).padStart(4, `0`)}`;

fs.mkdirSync(OUT, {recursive: true});

for (let t = 0; t < N_WS; t++) {
  const dir = path.join(OUT, `packages`, `pkg-${String(t).padStart(4, `0`)}`);
  fs.mkdirSync(dir, {recursive: true});

  const dependencies = {};
  const devDependencies = {};

  const dependencyCount = 8 + Math.floor(rand() * 15);
  for (let k = 0; k < dependencyCount; k++) {
    const name = pick(names);
    dependencies[name] = pick(candidates[name]);
  }

  const devDependencyCount = 4 + Math.floor(rand() * 8);
  for (let k = 0; k < devDependencyCount; k++) {
    const name = pick(names);
    if (!dependencies[name]) {
      devDependencies[name] = pick(candidates[name]);
    }
  }

  // Workspaces only depend on workspaces with a lower index, to avoid cycles
  if (t > 0) {
    const workspaceDependencyCount = Math.floor(rand() * 10);
    for (let k = 0; k < workspaceDependencyCount; k++) {
      dependencies[workspaceName(Math.floor(rand() * t))] = pick([`workspace:^`, `workspace:*`, `workspace:~`]);
    }
  }

  fs.writeFileSync(path.join(dir, `package.json`), `${JSON.stringify({
    name: workspaceName(t),
    version: `1.0.0`,
    private: true,
    bin: rand() < 0.1 ? {[`crazy-${t}`]: `./cli.js`} : undefined,
    dependencies: sortObject(dependencies),
    devDependencies: sortObject(devDependencies),
  }, null, 2)}\n`);
}

fs.writeFileSync(path.join(OUT, `package.json`), `${JSON.stringify({
  name: `crazy-monorepo`,
  private: true,
  workspaces: [`packages/*`],
}, null, 2)}\n`);

fs.writeFileSync(path.join(OUT, `.yarnrc.yml`), [
  `enableTelemetry: false`,
  `enableGlobalCache: false`,
  `npmMinimalAgeGate: 0`,
  `nodeLinker: pnp`,
  `pnpZipBackend: js`,
  `enableScripts: false`,
  `networkConcurrency: 32`,
  ``,
].join(`\n`));

fs.writeFileSync(path.join(OUT, `yarn.lock`), ``);

console.error(`done`);
