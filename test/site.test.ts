import { assessSite, isOwnScript, probeSite, signalsInHtml, signalsInScript } from '../src/site.js';

/** A `fetch` that serves `pages` by URL and answers 404 for anything else, and records what was asked for. */
function fakeFetch(pages: Record<string, string>): { fetch: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    asked.push(url);
    const body = pages[url];
    const response = new Response(body ?? 'not found', { status: body === undefined ? 404 : 200 });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  }) as typeof fetch;
  return { fetch: fetchImpl, asked };
}

describe('ng-checkup url', () => {
  it('follows the page into its own scripts and their imported chunks, and skips other sites', async () => {
    const { fetch, asked } = fakeFetch({
      'https://app.example.com/': [
        '<html><head><title>Example</title>',
        '<link rel="modulepreload" href="chunk-A.js">',
        '<script src="polyfills.js"></script><script type="module" src="main.js"></script>',
        '<script src="https://widgets.vendor.io/chat.js"></script>',
        '</head><body><app-root></app-root></body></html>',
      ].join(''),
      'https://app.example.com/polyfills.js': 'var t=Zone.__symbol__("x");',
      'https://app.example.com/main.js': 'import{a as b}from"./chunk-B.js";b();',
      'https://app.example.com/chunk-A.js': 'export const x=1;',
      // esbuild output: the version as a template literal, the runtime marker written as ɵcmp.
      'https://app.example.com/chunk-B.js': 'var Ts=class{constructor(t){this.full=t}};var V=new Ts(`19.2.14`);var c={ɵcmp:1};document.body.setAttribute(`ng-version`,V.full);',
      // A third-party widget built with React must not make the app a React app.
      'https://widgets.vendor.io/chat.js': 'var r={rendererPackageName:"react-dom",version:"18.3.1"};',
    });
    const probe = await probeSite('app.example.com', { fetch });
    expect(probe.title).toBe('Example');
    expect(probe.frameworks).toEqual([{ name: 'Angular', version: '19.2.14', evidence: 'chunk-B.js' }]);
    expect(probe.zoneJs).toBe(true);
    expect(probe.skipped).toBe(1);
    expect(asked).not.toContain('https://widgets.vendor.io/chat.js');
    expect(asked).toContain('https://app.example.com/chunk-B.js');

    const findings = assessSite(probe, 22);
    expect(findings.map((finding) => finding.message)).toEqual(['Angular 19.2.14 is 3 majors behind 22 and out of support']);
  });

  it('finds AngularJS from a CDN next to React, and calls it a migration under way', async () => {
    const { fetch } = fakeFetch({
      'https://shop.example.de/login': '<html><body ng-app="shop"><script src="https://ajax.googleapis.com/ajax/libs/angularjs/1.8.3/angular.min.js"></script><script src="/react.bundle.js"></script></body></html>',
      'https://ajax.googleapis.com/ajax/libs/angularjs/1.8.3/angular.min.js': '/*\n AngularJS v1.8.3\n (c) 2010-2020 Google LLC. http://angularjs.org\n*/(function(){})();',
      'https://shop.example.de/react.bundle.js': 'var x={version:"19.2.3",rendererPackageName:"react-dom"};',
    });
    const probe = await probeSite('https://shop.example.de/login', { fetch });
    expect(probe.frameworks.map((framework) => `${framework.name} ${framework.version ?? ''}`.trim())).toEqual(['AngularJS 1.8.3', 'React 19.2.3']);
    const [first] = assessSite(probe, 22);
    expect(first?.message).toBe('AngularJS 1.8.3 is end of life since January 2022');
    expect(first?.detail).toContain('next to React');
  });

  it('says so when nothing is recognisable, and fails only when the page itself fails', async () => {
    const { fetch } = fakeFetch({ 'https://static.example.org/': '<html><body><p>Hello</p></body></html>' });
    const probe = await probeSite('https://static.example.org/', { fetch });
    expect(probe.frameworks).toEqual([]);
    expect(assessSite(probe, 22)[0]?.message).toBe('No AngularJS, Angular, React or Vue in the page and the scripts read');
    await expect(probeSite('https://down.example.org/', { fetch })).rejects.toThrow('answered 404');
  });
});

describe('site signals', () => {
  it('takes AngularJS attributes only from tags, not from text that mentions them', () => {
    expect(signalsInHtml('<p>Bootstrap with the ng-app directive.</p><code>&lt;div ng-app="x"&gt;</code>').angularJs).toBeUndefined();
    expect(signalsInHtml('<div data-ng-app="x">').angularJs).toEqual({});
    expect(signalsInHtml('<my-app ng-version="21.0.3"></my-app>').angular).toEqual({ versions: ['21.0.3'] });
  });

  it('reads versions in the shapes builds ship them', () => {
    expect(signalsInScript('var v={full:"1.7.9",major:1,minor:7,dot:9};angular.module("a",[])').angularJs).toEqual({ version: '1.7.9' });
    expect(signalsInScript("var c={ɵcmp:1};new Xe('17.3.12');new Ye('17.3.12');new Ze('2.0.0')").angular).toEqual({ versions: ['17.3.12', '17.3.12', '2.0.0'] });
    expect(signalsInScript('app.__vue_app__=1').vue).toEqual({});
    expect(signalsInScript('document.createElement("div")').react).toBeUndefined();
  });

  it('treats a sibling subdomain as the same site', () => {
    expect(isOwnScript('https://cdn.example.com/a.js', 'https://app.example.com/')).toBe(true);
    expect(isOwnScript('https://cdn.other.net/a.js', 'https://app.example.com/')).toBe(false);
    expect(isOwnScript('https://cdnjs.cloudflare.com/ajax/libs/angular.js/1.8.2/angular.min.js', 'https://app.example.com/')).toBe(true);
  });
});
