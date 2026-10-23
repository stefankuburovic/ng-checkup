/**
 * `ng-checkup url <address>`: which frontend framework a public web app runs,
 * read from what any browser downloads.
 *
 * It loads the page and the scripts of the same site that the page names,
 * plus the chunks those scripts import statically (Angular 17+ keeps the
 * framework in `chunk-*.js` files the HTML never mentions), up to a fixed
 * number of requests. It recognises AngularJS and Angular with their
 * versions, whether zone.js is loaded, and React, Vue, Next.js and Nuxt,
 * including several in one app, which is what a migration in progress looks
 * like.
 *
 * Only the page's own site is read: third-party scripts are skipped, since a
 * cookie banner or a chat widget built with React would otherwise make any
 * site "a React app". The one exception is AngularJS loaded from a public
 * CDN, which is how many AngularJS apps include it. Nothing is clicked, no
 * form is submitted, no link is followed beyond the page itself.
 */

/** A framework found on the site. */
export interface DetectedFramework {
  name: 'AngularJS' | 'Angular' | 'React' | 'Vue' | 'Next.js' | 'Nuxt';
  /** Undefined when the framework is there but its version is not readable from the code. */
  version?: string;
  /** Where it was seen: a script's file name, or `the page`. */
  evidence: string;
}

/** The result of `probeSite`. */
export interface SiteProbe {
  /** The address asked for. */
  url: string;
  /** Where it ended up after redirects. */
  finalUrl: string;
  title?: string;
  frameworks: DetectedFramework[];
  /** For Angular: whether zone.js is among the scripts read. Undefined without Angular. */
  zoneJs?: boolean;
  /** The scripts read, with their size in bytes. */
  scripts: Array<{ url: string; bytes: number }>;
  /** Scripts named by the page but not read: another site, the request budget, or too large. */
  skipped: number;
}

/** What a page or a script shows on its own, merged by `probeSite`. */
export interface Signals {
  angularJs?: { version?: string };
  angular?: { versions: string[] };
  react?: { version?: string };
  vue?: { version?: string };
  next?: boolean;
  nuxt?: boolean;
  zoneJs?: boolean;
}

/** Most scripts read per site, imports included: enough for an app shell, few enough to stay polite. */
export const MAX_SCRIPTS = 12;
/** Scripts above this size are not read. */
export const MAX_SCRIPT_BYTES = 12_000_000;

/** Signals in a page's HTML. */
export function signalsInHtml(html: string): Signals {
  const signals: Signals = {};
  const ngVersion = /\sng-version="(\d+\.\d+\.\d+[^"]*)"/.exec(html)?.[1];
  if (ngVersion) signals.angular = { versions: [ngVersion] };
  // Only as an attribute inside a tag: documentation pages mention `ng-app` in their text (angular.dev does).
  if (/<[a-z][\w-]*\s[^<>]*?\b(?:data-)?ng-(?:app|controller|view)(?:\s*=|[\s/>])/i.test(html)) signals.angularJs = {};
  const cdn = /src=["'][^"']*angular(?:js|\.js)?[/@](1\.\d+\.\d+)[^"']*["']/i.exec(html)?.[1];
  if (cdn) signals.angularJs = { version: cdn };
  if (/__NEXT_DATA__|\/_next\/static\//.test(html)) signals.next = true;
  if (/__NUXT__|\/_nuxt\//.test(html)) signals.nuxt = true;
  if (/\sdata-v-[0-9a-f]{8}\b/.test(html)) signals.vue = {};
  return signals;
}

/** Signals in one script's code. */
export function signalsInScript(code: string): Signals {
  const signals: Signals = {};
  // AngularJS: the license header of an unminified build, or the version object every build carries.
  const angularJs = /AngularJS v(1\.\d+\.\d+)/.exec(code)?.[1] ?? /full:["'`](1\.\d+\.\d+)["'`],major:1,minor:/.exec(code)?.[1];
  if (angularJs) signals.angularJs = { version: angularJs };
  else if (/\bangular\.module\(/.test(code) && /\$rootScope|\$scope/.test(code)) signals.angularJs = {};

  // Angular: its runtime markers, then every `new Version("x.y.z")` (core, common, router, forms, material).
  // esbuild writes many strings as template literals, so every quote below also accepts a backtick.
  if (/ɵɵdefineComponent|ɵcmp|["'`]ng-version["'`]/.test(code)) {
    const versions = [...code.matchAll(/new\s+[\w$]+\(\s*["'`](\d{1,2}\.\d+\.\d+(?:[-+][\w.+-]+)?)["'`]\s*\)/g)].map((match) => match[1]!).filter((version) => Number(version.split('.')[0]) >= 2);
    signals.angular = { versions };
  }
  if (/__zone_symbol__|Zone\.__symbol__/.test(code)) signals.zoneJs = true;

  const reactVersion = /version:["'`](\d+\.\d+\.\d+[^"'`]*)["'`],rendererPackageName:["'`]react-dom["'`]/.exec(code)?.[1] ?? /rendererPackageName:["'`]react-dom["'`][^}]{0,200}?version:["'`](\d+\.\d+\.\d+[^"'`]*)["'`]/.exec(code)?.[1];
  if (reactVersion) signals.react = { version: reactVersion };
  else if (/__reactFiber\$|__reactContainer\$|rendererPackageName:["'`]react-dom["'`]/.test(code)) signals.react = {};

  if (/__vue_app__|__VUE_HMR_RUNTIME__/.test(code)) signals.vue = {};
  else if (/\b__vue__\b/.test(code)) {
    const vue2 = /\.version\s*=\s*["'`](2\.\d+\.\d+)["'`]/.exec(code)?.[1];
    signals.vue = vue2 ? { version: vue2 } : {};
  }
  return signals;
}

/**
 * The scripts a page names: `<script src>` and `<link rel="modulepreload">`,
 * as absolute URLs, in page order, each once.
 */
export function scriptsOfPage(html: string, base: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) found.push(match[1]!);
  for (const match of html.matchAll(/<link\b[^>]*\brel=["']modulepreload["'][^>]*\bhref=["']([^"']+)["'][^>]*>|<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']modulepreload["'][^>]*>/gi)) found.push((match[1] ?? match[2])!);
  return unique(found.map((src) => absolute(src, base)).filter((url): url is string => url !== undefined));
}

/** Chunks a script imports statically (`import"./chunk-AB12.js"`, `from"./chunk-AB12.js"`), as absolute URLs. */
export function importsOfScript(code: string, base: string): string[] {
  const found = [...code.matchAll(/(?:\bimport\s*|\bfrom\s*)["'](\.{1,2}\/[^"']+\.m?js)["']/g)].map((match) => match[1]!);
  return unique(found.map((src) => absolute(src, base)).filter((url): url is string => url !== undefined));
}

/**
 * True for a script worth reading: on the page's own site (the same host, or
 * a host sharing its last two labels, such as `cdn.example.com` for
 * `app.example.com`), or AngularJS from a public CDN.
 */
export function isOwnScript(scriptUrl: string, pageUrl: string): boolean {
  const script = new URL(scriptUrl);
  const page = new URL(pageUrl);
  const site = (host: string): string => host.split('.').slice(-2).join('.');
  if (script.hostname === page.hostname || site(script.hostname) === site(page.hostname)) return true;
  return /\/(?:angularjs\/1\.|angular\.js\/1\.|angular@1\.)/.test(script.pathname);
}

/** Options of `probeSite`. Tests pass their own `fetch`. */
export interface ProbeOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Loads the page and its scripts and merges what they show. Throws when the
 * page itself cannot be loaded; a script that fails to load is skipped.
 */
export async function probeSite(address: string, options: ProbeOptions = {}): Promise<SiteProbe> {
  const get = options.fetch ?? fetch;
  const timeout = options.timeoutMs ?? 15_000;
  const headers = { 'user-agent': 'Mozilla/5.0 (compatible; ng-checkup; +https://github.com/stefankuburovic/ng-checkup)', accept: 'text/html,application/javascript,*/*' };
  // `example.com` and `https://example.com` both become `https://example.com/`; a bad address throws here, before any request.
  const url = new URL(/^https?:\/\//i.test(address) ? address : `https://${address}`).href;

  const response = await get(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`.trim());
  const finalUrl = response.url || url;
  const html = await response.text();
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();

  const found: Array<{ signals: Signals; evidence: string }> = [{ signals: signalsInHtml(html), evidence: 'the page' }];
  const queue = scriptsOfPage(html, finalUrl);
  const seen = new Set<string>();
  const scripts: SiteProbe['scripts'] = [];
  let skipped = 0;
  while (queue.length > 0) {
    const scriptUrl = queue.shift()!;
    if (seen.has(scriptUrl)) continue;
    seen.add(scriptUrl);
    if (!isOwnScript(scriptUrl, finalUrl) || scripts.length >= MAX_SCRIPTS) {
      skipped++;
      continue;
    }
    try {
      const script = await get(scriptUrl, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
      const length = Number(script.headers.get('content-length') ?? 0);
      if (!script.ok || length > MAX_SCRIPT_BYTES) {
        skipped++;
        continue;
      }
      const code = await script.text();
      scripts.push({ url: scriptUrl, bytes: code.length });
      found.push({ signals: signalsInScript(code), evidence: fileName(scriptUrl) });
      queue.push(...importsOfScript(code, scriptUrl).filter((next) => !seen.has(next)));
    } catch {
      skipped++;
    }
  }
  return { url, finalUrl, ...(title ? { title } : {}), ...merge(found), scripts, skipped };
}

/** The frameworks of all signals together, each once, with the best version and the first place it was seen. */
function merge(found: Array<{ signals: Signals; evidence: string }>): Pick<SiteProbe, 'frameworks' | 'zoneJs'> {
  const frameworks: DetectedFramework[] = [];
  const add = (name: DetectedFramework['name'], pick: (signals: Signals) => { version?: string } | boolean | undefined): void => {
    const hits = found.filter(({ signals }) => pick(signals));
    if (hits.length === 0) return;
    const withVersion = hits.find(({ signals }) => {
      const value = pick(signals);
      return typeof value === 'object' && value.version;
    });
    const value = withVersion ? pick(withVersion.signals) : undefined;
    const version = typeof value === 'object' ? value.version : undefined;
    frameworks.push({ name, ...(version ? { version } : {}), evidence: (withVersion ?? hits[0]!).evidence });
  };
  add('AngularJS', (signals) => signals.angularJs);
  const angularVersions = found.flatMap(({ signals }) => signals.angular?.versions ?? []);
  const angularHits = found.filter(({ signals }) => signals.angular);
  if (angularHits.length > 0) {
    const version = mostCommon(angularVersions);
    const evidence = angularHits.find(({ signals }) => version && signals.angular?.versions.includes(version)) ?? angularHits[0]!;
    frameworks.push({ name: 'Angular', ...(version ? { version } : {}), evidence: evidence.evidence });
  }
  add('React', (signals) => signals.react);
  add('Vue', (signals) => signals.vue);
  add('Next.js', (signals) => signals.next);
  add('Nuxt', (signals) => signals.nuxt);
  const zoneJs = angularHits.length > 0 ? found.some(({ signals }) => signals.zoneJs) : undefined;
  return { frameworks, ...(zoneJs !== undefined ? { zoneJs } : {}) };
}

/** A finding about the site, in the same shape as a check's. */
export interface SiteFinding {
  severity: 'high' | 'medium' | 'low' | 'info';
  message: string;
  detail?: string;
}

/**
 * What the frameworks found mean for the site's owner. `latestAngular` is
 * the newest Angular major, for the support window: the newest three majors
 * get fixes, as in the version check.
 */
export function assessSite(probe: SiteProbe, latestAngular: number): SiteFinding[] {
  const findings: SiteFinding[] = [];
  const has = (name: DetectedFramework['name']): DetectedFramework | undefined => probe.frameworks.find((framework) => framework.name === name);
  const angularJs = has('AngularJS');
  const angular = has('Angular');
  const others = probe.frameworks.filter((framework) => framework.name !== 'AngularJS' && framework.name !== 'Next.js' && framework.name !== 'Nuxt');

  if (angularJs) {
    findings.push({
      severity: 'high',
      message: `AngularJS${angularJs.version ? ` ${angularJs.version}` : ''} is end of life since January 2022`,
      detail:
        others.length > 0
          ? `It runs next to ${others.map((framework) => framework.name).join(' and ')}, so a migration is under way. Until it is finished, the app ships a framework without security fixes.`
          : 'No security fixes since 31 December 2021. Nothing in AngularJS carries over to a current framework, so the way out is a migration, piece by piece.',
    });
  }
  if (angular?.version) {
    const major = Number(angular.version.split('.')[0]);
    const gap = Math.max(0, latestAngular - major);
    if (gap >= 3) findings.push({ severity: 'high', message: `Angular ${angular.version} is ${gap} majors behind ${latestAngular} and out of support`, detail: 'Only the newest three majors get fixes. `ng update` moves one major at a time, so this is a series of upgrade steps.' });
    else if (gap === 2) findings.push({ severity: 'medium', message: `Angular ${angular.version} is two majors behind and in its last months of support` });
    else if (gap === 1) findings.push({ severity: 'low', message: `Angular ${angular.version}, one major behind ${latestAngular}` });
    else findings.push({ severity: 'info', message: `Angular ${angular.version}, the current major` });
    if (probe.zoneJs === true && major >= 21) findings.push({ severity: 'low', message: 'Still loads zone.js', detail: 'Zoneless change detection is the default since Angular 21.' });
  } else if (angular) {
    findings.push({ severity: 'info', message: 'Angular, version not readable from the code' });
  }
  if (probe.frameworks.length === 0) {
    findings.push({
      severity: 'info',
      message: 'No AngularJS, Angular, React or Vue in the page and the scripts read',
      detail: 'The app may load only after sign-in, render entirely on the server, or keep its code on another site than the page.',
    });
  }
  return findings;
}

/** The newest version that appears most often, so one stray `new X("2.0.0")` cannot outvote Angular's own packages. */
function mostCommon(versions: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const version of versions) counts.set(version, (counts.get(version) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0], undefined, { numeric: true }))[0]?.[0];
}

/** `src` resolved against `base`, or undefined for anything that is not an http(s) URL (`data:`, `blob:`, garbage). */
function absolute(src: string, base: string): string | undefined {
  try {
    const url = new URL(src, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The values in their first order, each once. */
function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** The last path segment of a URL, which is how a report names a script. */
function fileName(url: string): string {
  return new URL(url).pathname.split('/').pop() || url;
}
