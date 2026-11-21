import {Hooks, Plugin, SettingsType}        from '@yarnpkg/core';
import {xfs}                                from '@yarnpkg/fslib';
import {NodeModulesHoistingLimits}          from '@yarnpkg/nm';

import {NodeModulesLinker, NodeModulesMode} from './NodeModulesLinker';
import {getGlobalHardlinksStore}            from './NodeModulesLinker';
import {isNodeModulesUpToDate}              from './NodeModulesLinker';
import {PnpLooseLinker}                     from './PnpLooseLinker';
import {getSpareTreeStore}                  from './spareTree';
import {refreshSpareTree}                   from './spareTree';
import {spareTreeInstalls}                  from './spareTree';

export {NodeModulesLinker};
export {NodeModulesMode};
export {PnpLooseLinker};

declare module '@yarnpkg/core' {
  interface ConfigurationValueMap {
    nmHoistingLimits: NodeModulesHoistingLimits;
    nmMode: NodeModulesMode;
    nmSelfReferences: boolean;
    nmSpareTree: boolean;
  }
}

const plugin: Plugin<Hooks> = {
  hooks: {
    cleanGlobalArtifacts: async configuration => {
      const globalHardlinksDirectory = getGlobalHardlinksStore(configuration);
      await xfs.removePromise(globalHardlinksDirectory);
      await xfs.removePromise(getSpareTreeStore(configuration));
    },
    isInstallUpToDate: async (upToDate, project) => {
      if (project.configuration.get(`nodeLinker`) !== `node-modules`)
        return upToDate;

      return await isNodeModulesUpToDate(project);
    },
    afterAllInstalled: async project => {
      const spareTreeInstall = spareTreeInstalls.get(project);
      if (typeof spareTreeInstall === `undefined`)
        return;

      spareTreeInstalls.delete(project);
      await refreshSpareTree(project, spareTreeInstall);
    },
  },
  configuration: {
    nmHoistingLimits: {
      description: `Prevents packages to be hoisted past specific levels`,
      type: SettingsType.STRING,
      values: [
        NodeModulesHoistingLimits.WORKSPACES,
        NodeModulesHoistingLimits.DEPENDENCIES,
        NodeModulesHoistingLimits.NONE,
      ],
      default: NodeModulesHoistingLimits.NONE,
    },
    nmMode: {
      description: `Defines in which measure Yarn must use hardlinks and symlinks when generated \`node_modules\` directories.`,
      type: SettingsType.STRING,
      values: [
        NodeModulesMode.CLASSIC,
        NodeModulesMode.HARDLINKS_LOCAL,
        NodeModulesMode.HARDLINKS_GLOBAL,
      ],
      default: NodeModulesMode.CLASSIC,
    },
    nmSelfReferences: {
      description: `Defines whether the linker should generate self-referencing symlinks for workspaces.`,
      type: SettingsType.BOOLEAN,
      default: true,
    },
    nmSpareTree: {
      description: `If true, when using \`nmMode: hardlinks-global\` Yarn keeps a spare copy of the freshly installed \`node_modules\` folders (made of hardlinks) in the global folder, and moves it into place the next time they are all missing instead of linking every file again. The copy is made in the background after the install, and is only used if none of its files changed since. Not available on Windows.`,
      type: SettingsType.BOOLEAN,
      default: true,
    },
  },
  linkers: [
    NodeModulesLinker,
    PnpLooseLinker,
  ],
};

// eslint-disable-next-line arca/no-default-export
export default plugin;
