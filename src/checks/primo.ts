import type { AngularJsFileFacts } from '../angularjs.js';
import { hookSelector, NDE_CUSTOM_MODULE_ANGULAR, viewRootOf } from '../primo.js';
import type { CheckResult, FileRef, Finding, Grade } from '../types.js';
import { formatCount, plural, verb, type AnalysisContext } from './context.js';

/** One Primo VE view package (an `INST-VIEW` folder), or the central package shared by a network's views. */
export interface PrimoView {
  /** The folder, `.` when the package is the repository itself. */
  root: string;
  /** A network's central package (`…CENTRAL_PACKAGE`), which every view of the network loads. */
  central: boolean;
  /** Primo hook slots the view fills, as selectors (`prm-search-bar-after`), each once. */
  hooks: string[];
  /**
   * Other AngularJS components and directives of the view (helpers the hooks
   * render), each name once. Controllers are not counted: in a Primo package
   * they are registered separately for the components that use them.
   */
  components: number;
  services: number;
  parentCtrlReads: number;
  httpCalls: number;
  integrations: string[];
  /** Languages of static home pages (`home_en.html`, `homepage/homepage_de.html`). */
  homePages: string[];
  /** The file with the first hook, for examples. */
  firstHook?: FileRef;
}

/** What the Primo check and the NDE plan both need. */
export interface PrimoSummary {
  present: boolean;
  views: PrimoView[];
  hooks: number;
  components: number;
  parentCtrlReads: number;
  httpCalls: number;
  integrations: string[];
  parentCtrlFiles: FileRef[];
  /** The `parentCtrl` paths read most, most first, with how often: what to find again in NDE. */
  topParentCtrlPaths: Array<{ path: string; reads: number }>;
}

/**
 * True when the repository holds a Primo VE customization package: the
 * `viewCustom` module, or a component registered under a Primo hook name.
 * The AngularJS area and its migration plan then give way to this one,
 * since a Primo package does not move to Angular through ngUpgrade: it is
 * rebuilt in the NDE custom module.
 */
export function hasPrimo(context: AnalysisContext): boolean {
  return summarizePrimo(context).present;
}

/**
 * Counts a repository's Primo packages view by view. Names are counted once
 * per view and a checked-in `js/custom.js` that merely concatenates the
 * view's other files is left out of the line counts, so a package that
 * ships its build next to its sources is not counted twice.
 */
export function summarizePrimo(context: AnalysisContext): PrimoSummary {
  const files = context.angularJs.files.filter((file) => !file.isSpec);
  const present = files.some((file) => file.primo?.viewCustom || file.registrations.some((registration) => hookSelector(registration.name) !== undefined));
  if (!present) return { present, views: [], hooks: 0, components: 0, parentCtrlReads: 0, httpCalls: 0, integrations: [], parentCtrlFiles: [], topParentCtrlPaths: [] };

  // A view is a folder with a `js/` folder. Files elsewhere are copies and leftovers (an
  // "old_primo.js" beside the package, an unbundled copy in a scratch folder), unless the
  // repository has no `js/` folder at all, in which case it is one view.
  const inJs = (path: string): boolean => path.startsWith('js/') || path.includes('/js/');
  const viewFiles = files.some((file) => inJs(file.path)) ? files.filter((file) => inJs(file.path)) : files;
  const byView = new Map<string, AngularJsFileFacts[]>();
  for (const file of viewFiles) {
    const root = files.some((candidate) => inJs(candidate.path)) ? viewRootOf(file.path) : '.';
    byView.set(root, [...(byView.get(root) ?? []), file]);
  }
  const templates = context.templates.filter((template) => !template.inline).map((template) => template.path);
  const views: PrimoView[] = [];
  const parentCtrlFiles: FileRef[] = [];
  const pathReads = new Map<string, number>();
  for (const [root, filesOfView] of byView) {
    const counted = withoutBundle(root, filesOfView);
    const hooks = new Set<string>();
    const others = new Set<string>();
    const services = new Set<string>();
    let firstHook: FileRef | undefined;
    for (const file of filesOfView) {
      for (const registration of file.registrations) {
        if (registration.downgraded) continue;
        const selector = hookSelector(registration.name);
        if (selector) {
          hooks.add(selector);
          firstHook ??= { path: file.path, line: registration.line };
        } else if (registration.kind === 'service' || registration.kind === 'factory' || registration.kind === 'provider') services.add(registration.name);
        else if (registration.kind === 'component' || registration.kind === 'directive') others.add(registration.name);
      }
    }
    const isPrimoView = hooks.size > 0 || filesOfView.some((file) => file.primo?.viewCustom);
    if (!isPrimoView) continue;
    for (const file of counted) {
      if (file.primo && file.primo.parentCtrlLines.length > 0) parentCtrlFiles.push({ path: file.path, line: file.primo.parentCtrlLines[0] });
      for (const path of file.primo?.parentCtrlPaths ?? []) pathReads.set(path, (pathReads.get(path) ?? 0) + 1);
    }
    const prefix = root === '.' ? '' : `${root}/`;
    const homePages = templates
      .filter((path) => path.startsWith(prefix))
      .map((path) => /\/html\/(?:homepage\/)?home(?:page)?_([a-z]{2}(?:[-_][A-Za-z]{2})?)\.html$/.exec(`/${path}`)?.[1])
      .filter((lang): lang is string => lang !== undefined);
    views.push({
      root,
      central: /CENTRAL_PACKAGE/i.test(root),
      hooks: [...hooks].sort(),
      components: others.size,
      services: services.size,
      parentCtrlReads: counted.reduce((sum, file) => sum + (file.primo?.parentCtrlLines.length ?? 0), 0),
      httpCalls: counted.reduce((sum, file) => sum + (file.primo?.httpCalls ?? 0), 0),
      integrations: [...new Set(counted.flatMap((file) => file.primo?.integrations ?? []))].sort(),
      homePages: [...new Set(homePages)].sort(),
      ...(firstHook ? { firstHook } : {}),
    });
  }
  views.sort((left, right) => Number(right.central) - Number(left.central) || right.hooks.length - left.hooks.length || left.root.localeCompare(right.root));
  return {
    present: views.length > 0,
    views,
    hooks: views.reduce((sum, view) => sum + view.hooks.length, 0),
    components: views.reduce((sum, view) => sum + view.components, 0),
    parentCtrlReads: views.reduce((sum, view) => sum + view.parentCtrlReads, 0),
    httpCalls: views.reduce((sum, view) => sum + view.httpCalls, 0),
    integrations: [...new Set(views.flatMap((view) => view.integrations))].sort(),
    parentCtrlFiles,
    topParentCtrlPaths: [...pathReads.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 6).map(([path, reads]) => ({ path, reads })),
  };
}

/**
 * The view's files without `js/custom.js` when that file only repeats the
 * others: when every component the other files register is registered in
 * `custom.js` too, it is their concatenated build.
 */
function withoutBundle(root: string, files: AngularJsFileFacts[]): AngularJsFileFacts[] {
  const bundlePath = root === '.' ? 'js/custom.js' : `${root}/js/custom.js`;
  const bundle = files.find((file) => file.path === bundlePath);
  const others = files.filter((file) => file !== bundle);
  if (!bundle || others.length === 0) return files;
  const inBundle = new Set(bundle.registrations.map((registration) => registration.name));
  const otherNames = others.flatMap((file) => file.registrations.map((registration) => registration.name));
  return otherNames.length > 0 && otherNames.every((name) => inBundle.has(name)) ? others : files;
}

/**
 * How much of a Primo VE customization has to be rebuilt for Primo's New
 * Discovery Experience, and what makes it hard.
 *
 * Ex Libris announced NDE as the only Primo UI from January 2028, and VE
 * customizations do not carry over: NDE is extended through an Angular
 * custom module (ExLibrisGroup/customModule, Angular 18 in October 2026)
 * whose components are mapped to `nde-…` selectors. So the unit of work is
 * the hook: every `prm-…-after`/`-before` slot the package fills is rebuilt as
 * an Angular component. What makes a hook expensive is `parentCtrl`, the VE
 * hook's handle on Primo's internal AngularJS controller; NDE offers
 * `hostComponent` and the NgRx app state instead, so every read is found
 * again there.
 */
export function primoNdeCheck(context: AnalysisContext): CheckResult {
  const s = summarizePrimo(context);
  const findings: Finding[] = [];
  const max = context.maxExamples;
  const plainViews = s.views.filter((view) => !view.central);
  const central = s.views.find((view) => view.central);

  findings.push({
    severity: 'high',
    message: 'Primo VE customizations do not carry over to NDE, announced as the only Primo UI from January 2028',
    detail: `The New Discovery Experience is extended through an Angular custom module (ExLibrisGroup/customModule, Angular ${NDE_CUSTOM_MODULE_ANGULAR}), where each customization is an Angular component mapped to an \`nde-…\` selector in \`selectorComponentMap\`. There is no hybrid route as for an AngularJS app: the package is rebuilt hook by hook, and it can be developed against the live view with the module's proxy mode before go-live.`,
  });

  if (s.hooks > 0) {
    const examples = s.views.flatMap((view) => (view.firstHook ? [view.firstHook] : [])).slice(0, max);
    const common = [...new Set(s.views.flatMap((view) => view.hooks))].slice(0, 8);
    findings.push({
      severity: 'medium',
      message: `${plural(s.hooks, 'Primo hook')} to rebuild${s.views.length > 1 ? ` across ${plural(s.views.length, 'view')}` : ''}${s.components > 0 ? `, with ${plural(s.components, 'helper component')}` : ''}`,
      detail: `Each \`prm-…-after\`/\`-before\` slot the package fills becomes an Angular component in the custom module, mapped to the matching \`nde-…\` selector; NDE's names follow its own layout, so each slot's counterpart is found in the NDE UI first. Hooks used: ${common.map((hook) => `\`${hook}\``).join(', ')}${common.length < new Set(s.views.flatMap((view) => view.hooks)).size ? ', …' : ''}.`,
      files: examples,
      count: s.hooks,
    });
  }

  if (s.parentCtrlReads > 0) {
    findings.push({
      severity: 'medium',
      message: `\`parentCtrl\` read in ${plural(s.parentCtrlReads, 'place')}`,
      detail: `\`parentCtrl\` is the VE hook's handle on the internal AngularJS controller of the Primo component it extends. NDE has no such controller: a custom component gets \`hostComponent\` (the Angular component instance, with a different shape) and reads the app state through NgRx selectors. Each read is found again there, and it is where most of the effort and the risk of a hook sits.${s.topParentCtrlPaths.length > 0 ? ` Read most: ${s.topParentCtrlPaths.map((entry) => `\`${entry.path}\` (${entry.reads})`).join(', ')}.` : ''}`,
      files: s.parentCtrlFiles.slice(0, max),
      count: s.parentCtrlFiles.length,
    });
  }

  if (s.integrations.length > 0) {
    findings.push({
      severity: 'medium',
      message: `${plural(s.integrations.length, 'third-party integration')} to rebuild or replace`,
      detail: `${s.integrations.join(', ')}. Check each vendor for an NDE version first (Third Iron has announced one for BrowZine and LibKey); whatever has none is rebuilt as a component of the custom module.`,
    });
  }

  if (central && plainViews.length > 0) {
    findings.push({
      severity: 'info',
      message: `A central package and ${plural(plainViews.length, 'view')}`,
      detail:
        central.hooks.length > 0
          ? `\`${central.root}\` is loaded by every view of the network, so its ${plural(central.hooks.length, 'hook')} ${verb(central.hooks.length, 'is', 'are')} rebuilt once for all of them; the views add their own on top.`
          : `\`${central.root}\` is loaded by every view of the network. It fills no hook itself, but the shared code and styles every view relies on move with it, first.`,
    });
  }

  const homePages = [...new Set(s.views.flatMap((view) => view.homePages))];
  if (homePages.length > 0) {
    findings.push({
      severity: 'low',
      message: `Static home pages in ${plural(homePages.length, 'language')} (${homePages.join(', ')})`,
      detail: 'They move to `src/assets/homepage/homepage_<lang>.html` of the custom module, with the CSS and images to `src/assets`. Mostly copying, but the markup is Angular now: AngularJS directives in it stop working.',
    });
  }

  const grade: Grade = s.parentCtrlReads > 0 || s.hooks > 10 ? 'poor' : 'fair';
  const summary = `Primo VE customization: ${plural(s.hooks, 'hook')}${s.views.length > 1 ? ` in ${plural(s.views.length, 'view')}` : ''}, ${plural(s.parentCtrlReads, '`parentCtrl` read')} to rebuild for NDE.`;

  return {
    id: 'primo-nde',
    title: 'Primo NDE migration',
    grade,
    summary,
    metrics: [
      { label: 'Views', value: formatCount(s.views.length), hint: central ? 'including the central package' : 'customization packages' },
      { label: 'Hooks', value: formatCount(s.hooks), hint: `${formatCount(s.components)} helper components` },
      { label: 'parentCtrl reads', value: formatCount(s.parentCtrlReads), hint: `in ${plural(s.parentCtrlFiles.length, 'file')}` },
      { label: 'Integrations', value: formatCount(s.integrations.length), hint: 'third-party' },
      { label: 'Requests', value: formatCount(s.httpCalls), hint: `\`$http\` ${verb(s.httpCalls, 'call', 'calls')}` },
    ],
    findings,
    measures: [
      { id: 'primo-hooks', label: 'Primo hooks', value: s.hooks },
      { id: 'primo-helper-components', label: 'Primo helper components', value: s.components },
      { id: 'parentctrl-reads', label: 'parentCtrl reads', value: s.parentCtrlReads },
      { id: 'primo-integrations', label: 'Third-party integrations in the package', value: s.integrations.length },
    ],
  };
}
