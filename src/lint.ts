import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceInfo } from './workspace.js';

/** The lint configuration of a workspace, as far as the version check judges it. */
export interface LintFacts {
  /** `tslint.json` files at the workspace root and in project roots, as report paths. */
  tslintConfigs: string[];
  /** ESLint config files at the workspace root and in project roots, and whether each turns on template accessibility rules. */
  eslintConfigs: Array<{ path: string; templateAccessibility: boolean }>;
}

const ESLINT_FILES = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yml', '.eslintrc.yaml'];

/**
 * angular-eslint's accessibility rules for templates, however they are turned
 * on: the shared config (`plugin:@angular-eslint/template/accessibility` in an
 * `.eslintrc`, `angular.configs.templateAccessibility` in a flat config) or
 * one of its rules by name.
 */
const TEMPLATE_ACCESSIBILITY = /template\/accessibility|templateAccessibility|@angular-eslint\/template\/(alt-text|label-has-associated-control|click-events-have-key-events|interactive-supports-focus|elements-content|valid-aria|role-has-required-aria|mouse-events-have-key-events)/;

/**
 * Reads the lint configuration files of the workspace root and of every
 * project root. Only the files' presence and, for ESLint, whether template
 * accessibility is named anywhere in them: the config is text, not run, so a
 * rule set through a shared package the config imports is not seen.
 */
export function readLintFacts(workspace: WorkspaceInfo): LintFacts {
  const prefix = workspace.subfolder ? `${workspace.subfolder}/` : '';
  const roots = [...new Set(['', ...workspace.projects.map((project) => project.root)])];
  const tslintConfigs: string[] = [];
  const eslintConfigs: LintFacts['eslintConfigs'] = [];
  for (const root of roots) {
    const at = (name: string): string => (root ? `${root}/${name}` : name);
    if (existsSync(join(workspace.root, at('tslint.json')))) tslintConfigs.push(`${prefix}${at('tslint.json')}`);
    for (const name of ESLINT_FILES) {
      const absolute = join(workspace.root, at(name));
      if (!existsSync(absolute)) continue;
      let text = '';
      try {
        text = readFileSync(absolute, 'utf8');
      } catch {
        // An unreadable config counts as one without the rules, which is what the finding then says to check.
      }
      eslintConfigs.push({ path: `${prefix}${at(name)}`, templateAccessibility: TEMPLATE_ACCESSIBILITY.test(text) });
    }
  }
  return { tslintConfigs, eslintConfigs };
}
