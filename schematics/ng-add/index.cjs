'use strict';
/**
 * `ng add ng-checkup`.
 *
 * The Angular CLI has already installed the package and saved it to
 * devDependencies (see "ng-add" in package.json) by the time this runs, so the
 * rule only applies the same plan `ng-checkup init` does, through the CLI's
 * virtual tree: nothing is written unless the whole schematic succeeds, and
 * `ng add --dry-run` shows the changes for free.
 *
 * Written as CommonJS on purpose. The Angular CLI loads schematic factories
 * with `require`, while the rest of this package is ESM; the planner is
 * therefore loaded with a dynamic `import()`, which a CommonJS module may do
 * and which Angular's rule runner awaits.
 *
 * It deliberately depends on nothing from @angular-devkit: the Tree and
 * context are passed in by the CLI, so the package needs no schematics
 * dependency of its own.
 */
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * @param {{ ci?: 'auto' | 'github' | 'gitlab' | 'none', force?: boolean }} options
 */
function ngAdd(options) {
  return async (tree, context) => {
    const { planInit, runCheckup, createBaseline, serializeBaseline, BASELINE_FILE } = await import(pathToFileURL(join(__dirname, '..', '..', 'dist', 'index.js')).href);
    const { version } = require(join(__dirname, '..', '..', 'package.json'));

    // The first baseline measures the workspace on disk (the CLI runs ng add
    // from its root). The tree only holds pending changes, and none of them
    // touch source files, so the disk is what the code looks like.
    const baseline = tree.exists(`/${BASELINE_FILE}`) ? undefined : serializeBaseline(createBaseline(await runCheckup(process.cwd(), { offline: true })));

    const plan = planInit(
      {
        read: (path) => {
          const buffer = tree.read(`/${path}`);
          return buffer ? buffer.toString('utf8') : undefined;
        },
        exists: (path) => {
          if (tree.exists(`/${path}`)) return true;
          // Tree.exists only knows files; a directory exists when it holds something.
          const directory = tree.getDir(`/${path}`);
          return directory.subfiles.length > 0 || directory.subdirs.length > 0;
        },
      },
      { ci: options.ci ?? 'auto', force: options.force ?? false, addDependency: false, version, baseline },
    );

    for (const change of plan.changes) {
      const path = `/${change.path}`;
      if (tree.exists(path)) tree.overwrite(path, change.content);
      else tree.create(path, change.content);
      context.logger.info(`ng-checkup: ${change.path}: ${change.summary}`);
    }
    if (plan.changes.length === 0) context.logger.info('ng-checkup is already configured here.');
    for (const note of plan.notes) context.logger.warn(note);
    context.logger.info(`Run the checkup with: ${plan.nextSteps[plan.nextSteps.length - 1]}`);
    return tree;
  };
}

module.exports = { ngAdd };
