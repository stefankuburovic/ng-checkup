/**
 * Ex Libris Primo VE customization packages: what is in them, for the move
 * to the New Discovery Experience (NDE).
 *
 * A Primo VE package is AngularJS code that the Primo UI loads into its own
 * AngularJS app: a module named `viewCustom` and components registered under
 * the names of Primo's hook directives (`prmSearchBarAfter` fills the
 * `<prm-search-bar-after>` slot after the search bar), which reach into the
 * Primo component they extend through a `parentCtrl` binding. NDE replaces
 * all of it with an Angular custom module (ExLibrisGroup/customModule), where
 * a component is mapped to an `nde-…` selector and gets `hostComponent` and
 * the NgRx app state instead. Nothing carries over, so this module counts
 * what has to be rebuilt.
 */

/** Primo-specific facts of one file, gathered by `scanAngularJsFile` for files that look like a Primo package. */
export interface PrimoFileFacts {
  /** Defines or extends the `viewCustom` module. */
  viewCustom: boolean;
  /** Lines reading from `parentCtrl` (`parentCtrl.x`), the VE hook's handle on Primo's internal AngularJS controller. */
  parentCtrlLines: number[];
  /** Every `parentCtrl.a.b` path read, up to two levels (`loc.items`), once per read. */
  parentCtrlPaths: string[];
  /** Third-party integrations named in the file, by the labels of `INTEGRATIONS`. */
  integrations: string[];
  /** Calls of the injected `$http` service: requests to rebuild with `HttpClient`. */
  httpCalls: number;
}

/**
 * Integrations Primo libraries commonly add through the customization
 * package, recognised by a string in the code. Each one is rebuilt for NDE
 * or replaced by the vendor's own NDE version; Third Iron has announced one
 * for BrowZine and LibKey.
 */
export const INTEGRATIONS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'BrowZine / LibKey (Third Iron)', pattern: /browzine|libkey|thirdiron/i },
  { label: 'Altmetric', pattern: /altmetric/i },
  { label: 'Unpaywall', pattern: /unpaywall|oadoi/i },
  { label: 'Google Analytics / Tag Manager', pattern: /googletagmanager|google-analytics|\bgtag\(/i },
  { label: 'Matomo', pattern: /matomo|\b_paq\b/ },
  { label: 'LibChat (Springshare)', pattern: /libchat|springshare/i },
  { label: 'LibraryH3lp', pattern: /libraryh3lp/i },
  { label: 'HathiTrust', pattern: /hathitrust/i },
  { label: 'StackMap', pattern: /stackmap/i },
];

/** Cheap test: only files with one of these get Primo facts. */
const PRIMO_CANDIDATE = /viewCustom|parentCtrl|\bprm[A-Z]\w*(?:After|Before)\b/;

/** Primo facts of a file's text, or undefined for a file that has nothing Primo in it. */
export function primoFactsOf(text: string): PrimoFileFacts | undefined {
  if (!PRIMO_CANDIDATE.test(text)) return undefined;
  const lines = text.split('\n');
  const parentCtrlLines: number[] = [];
  const parentCtrlPaths: string[] = [];
  let httpCalls = 0;
  lines.forEach((line, index) => {
    // A read is `parentCtrl.x` or `parentCtrl[...]`; `bindings: { parentCtrl: '<' }`, which every hook declares, is not one.
    if (/\bparentCtrl\s*[.[]/.test(line)) parentCtrlLines.push(index + 1);
    for (const match of line.matchAll(/\bparentCtrl\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/g)) parentCtrlPaths.push(match[1]!);
    httpCalls += (line.match(/\$http\s*(?:\.\s*(?:get|post|put|delete|jsonp|head|patch)\s*)?\(/g) ?? []).length;
  });
  return {
    viewCustom: /angular\s*\.\s*module\(\s*['"`]viewCustom['"`]/.test(text),
    parentCtrlLines,
    parentCtrlPaths,
    integrations: INTEGRATIONS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.label),
    httpCalls,
  };
}

/** `prmSearchBarAfter` → `prm-search-bar-after`; undefined for a name that is not a Primo hook. */
export function hookSelector(name: string): string | undefined {
  if (!/^prm[A-Z]\w*(?:After|Before)$/.test(name)) return undefined;
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * The view a file belongs to: the folder that holds its `js/` folder
 * (`41SLSP_NETWORK-VU1_UNION/js/x.js` → `41SLSP_NETWORK-VU1_UNION`), `.` for
 * a package checked out at its own root, else the file's folder.
 */
export function viewRootOf(path: string): string {
  const index = path.lastIndexOf('/js/');
  if (index > 0) return path.slice(0, index);
  if (path.startsWith('js/')) return '.';
  const slash = path.lastIndexOf('/');
  return slash > 0 ? path.slice(0, slash) : '.';
}

/** The Angular major of ExLibrisGroup/customModule when this release was made (its package.json, October 2026). */
export const NDE_CUSTOM_MODULE_ANGULAR = 18;
