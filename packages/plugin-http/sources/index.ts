import {Hooks, Plugin, structUtils} from '@yarnpkg/core';

import {TarballHttpFetcher}         from './TarballHttpFetcher';
import {TarballHttpResolver}        from './TarballHttpResolver';
import {isTgzUrl}                   from './urlUtils';

export {TarballHttpFetcher};
export {TarballHttpResolver};

const plugin: Plugin<Hooks> = {
  hooks: {
    // Tarballs are only immutable if the lockfile pins their content
    getUpToDateKeyPart: async (project, locator) => {
      if (!isTgzUrl(locator.reference))
        return undefined;

      const checksum = project.storedChecksums.get(locator.locatorHash);
      if (typeof checksum === `undefined`)
        return null;

      return [structUtils.stringifyLocator(locator), checksum].join(`\0`);
    },
  },
  fetchers: [
    TarballHttpFetcher,
  ],
  resolvers: [
    TarballHttpResolver,
  ],
};

// eslint-disable-next-line arca/no-default-export
export default plugin;
