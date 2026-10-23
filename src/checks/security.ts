import type { SourceFileFacts } from '../scan.js';
import type { CheckResult, FileRef, Finding, Grade } from '../types.js';
import { compareVersions, severityRank } from '../vulnerabilities.js';
import { applicationFiles, formatCount, plural, type AnalysisContext } from './context.js';

/**
 * The places where the code steps around Angular's built-in XSS protection.
 *
 * Angular sanitizes every value bound into the DOM, so an Angular app is safe
 * from cross-site scripting by default; the holes are the escape hatches.
 * This check counts them, it does not judge them: a `bypassSecurityTrustHtml`
 * on a constant is fine, the same call on a user's comment is an XSS. That
 * is why bypasses only make the area `fair` (each needs a look), while HTML
 * written straight into the DOM, or a string run as code, makes it `poor`:
 * those skip the sanitizer for every value, not one reviewed value.
 *
 * Found by name in the syntax tree, without types, like the rest of the tool:
 * `x.innerHTML = …` counts whatever `x` is. Spec files are left out.
 */
export function securityCheck(context: AnalysisContext): CheckResult {
  const files = applicationFiles(context);
  const templates = context.templates.filter((template) => !template.path.endsWith('.spec.ts'));
  const bypass = sites(files, (file) => file.bypassSecurityLines);
  const unsafeDom = sites(files, (file) => file.unsafeDomLines);
  const dynamicCode = sites(files, (file) => file.dynamicCodeLines);
  const innerHtml = templates.filter((template) => template.stats.innerHtmlBindings > 0);
  const innerHtmlCount = templates.reduce((sum, template) => sum + template.stats.innerHtmlBindings, 0);
  const examples = (refs: FileRef[]): Pick<Finding, 'files' | 'count'> => ({ files: refs.slice(0, context.maxExamples), count: refs.length });

  const findings: Finding[] = [];
  if (unsafeDom.length > 0) {
    findings.push({
      severity: 'high',
      message: `HTML is written into the DOM past Angular's sanitizer in ${plural(unsafeDom.length, 'place')}`,
      detail:
        'An assignment to `innerHTML`/`outerHTML`, `insertAdjacentHTML`, `document.write` or `Renderer2.setProperty(el, \'innerHTML\', …)` puts the string into the page unsanitized. If any part of it comes from a user or an API, it is an XSS. Bind with `[innerHTML]` instead, which Angular sanitizes, or build the elements with the renderer.',
      ...examples(unsafeDom),
    });
  }
  if (dynamicCode.length > 0) {
    findings.push({
      severity: 'high',
      message: `Strings are run as code in ${plural(dynamicCode.length, 'place')} (\`eval\`, \`new Function\`)`,
      detail: 'Code built from strings is an injection risk, and it forces `unsafe-eval` into the Content Security Policy, which switches off the protection a strict CSP gives against every other XSS.',
      ...examples(dynamicCode),
    });
  }
  if (bypass.length > 0) {
    findings.push({
      severity: 'medium',
      message: `Angular's sanitization is bypassed in ${plural(bypass.length, 'place')} (\`bypassSecurityTrust*\`)`,
      detail: 'Each call tells Angular the value is safe and must not be sanitized. That holds for a constant or a value the app built itself, and is an XSS for anything a user or an API supplied. Review where each value comes from; an allow-list sanitizer such as DOMPurify is the usual fix when it is user content.',
      ...examples(bypass),
    });
  }
  if (innerHtmlCount > 0) {
    findings.push({
      severity: 'low',
      message: `${plural(innerHtmlCount, '`[innerHTML]` binding')} in ${plural(innerHtml.length, 'template')}`,
      detail: 'Angular sanitizes these, so they are safe on their own: scripts and event handlers are stripped. They become a hole only when the bound value went through `bypassSecurityTrustHtml`, which is worth checking for each one.',
      ...examples(innerHtml.map((template) => ({ path: template.path }))),
    });
  }

  const scan = context.vulnerabilities;
  const runtime = scan?.packages.filter((entry) => !entry.dev) ?? [];
  const tooling = scan?.packages.filter((entry) => entry.dev) ?? [];
  const runtimeCount = runtime.reduce((sum, entry) => sum + entry.vulnerabilities.length, 0);
  const severe = runtime.reduce((sum, entry) => sum + entry.vulnerabilities.filter((vulnerability) => severityRank(vulnerability.severity) >= 3).length, 0);
  const moderate = runtime.some((entry) => entry.vulnerabilities.some((vulnerability) => vulnerability.severity === 'moderate'));
  if (runtimeCount > 0) {
    findings.unshift({
      severity: severe > 0 ? 'high' : moderate ? 'medium' : 'low',
      message: `${plural(runtimeCount, 'known vulnerability', 'known vulnerabilities')} in ${plural(runtime.length, 'dependency', 'dependencies')}${severe > 0 ? ` (${formatCount(severe)} high or critical)` : ''}`,
      detail: `${runtime
        .slice(0, 6)
        .map((entry) => {
          const cves = [...new Set(entry.vulnerabilities.flatMap((vulnerability) => vulnerability.cves))];
          const fixes = [...new Set(entry.vulnerabilities.map((vulnerability) => vulnerability.fixedIn).filter((fixed): fixed is string => fixed !== undefined))];
          const unfixed = entry.vulnerabilities.some((vulnerability) => vulnerability.fixedIn === undefined);
          const fix = unfixed ? (fixes.length > 0 ? 'some without a fixed version' : 'no fixed version') : `all fixed by ${fixes.sort(compareVersions).pop()}`;
          return `\`${entry.name}\` ${entry.version}: ${plural(entry.vulnerabilities.length, 'advisory', 'advisories')}${cves.length > 0 ? ` (${cves.slice(0, 3).join(', ')}${cves.length > 3 ? ', …' : ''})` : ''}, ${fix}`;
        })
        .join('; ')}${runtime.length > 6 ? `; and ${plural(runtime.length - 6, 'more dependency', 'more dependencies')}` : ''}. Direct dependencies at their exact versions, from the advisories in osv.dev; the full dependency tree is \`npm audit\`'s job.`,
    });
  }
  if (tooling.length > 0) {
    findings.push({
      severity: 'low',
      message: `${plural(tooling.reduce((sum, entry) => sum + entry.vulnerabilities.length, 0), 'known vulnerability', 'known vulnerabilities')} in development tooling`,
      detail: `${tooling.map((entry) => `\`${entry.name}\` ${entry.version}`).join(', ')}. Not shipped to users, but they run on developer machines and in CI.`,
    });
  }

  const codeGrade: Grade = files.length === 0 ? 'info' : unsafeDom.length > 0 || dynamicCode.length > 0 ? 'poor' : bypass.length > 0 ? 'fair' : 'good';
  // Known vulnerabilities grade an app even without TypeScript to read (an AngularJS app on 1.8.3).
  const grade: Grade = severe > 0 ? 'poor' : moderate && codeGrade !== 'poor' ? 'fair' : codeGrade === 'info' && scan && scan.checked > 0 ? (runtimeCount > 0 ? 'fair' : 'good') : codeGrade;
  const vulnerabilitySummary = runtimeCount > 0 ? `; ${plural(runtimeCount, 'known vulnerability', 'known vulnerabilities')} in dependencies` : '';
  return {
    id: 'security',
    title: 'Security',
    grade,
    summary:
      files.length === 0
        ? runtimeCount > 0
          ? `No TypeScript application code to check; ${plural(runtimeCount, 'known vulnerability', 'known vulnerabilities')} in ${plural(runtime.length, 'dependency', 'dependencies')}.`
          : 'No application code to check.'
        : codeGrade === 'good'
          ? `No sanitizer bypasses, direct DOM HTML writes or eval in ${plural(files.length, 'file')}${innerHtmlCount > 0 ? `; ${plural(innerHtmlCount, 'sanitized [innerHTML] binding')}` : ''}${vulnerabilitySummary}.`
          : `${plural(unsafeDom.length, 'direct DOM HTML write')}, ${plural(dynamicCode.length, 'eval')}, ${plural(bypass.length, 'sanitizer bypass', 'sanitizer bypasses')}${vulnerabilitySummary}.`,
    metrics: [
      { label: 'Direct DOM HTML writes', value: formatCount(unsafeDom.length), hint: 'innerHTML =, insertAdjacentHTML' },
      { label: 'Sanitizer bypasses', value: formatCount(bypass.length), hint: 'bypassSecurityTrust*' },
      { label: 'eval / new Function', value: formatCount(dynamicCode.length) },
      { label: '[innerHTML] bindings', value: formatCount(innerHtmlCount), hint: 'sanitized by Angular' },
      scan
        ? { label: 'Known vulnerabilities', value: formatCount(runtimeCount), hint: `in ${plural(scan.checked, 'direct dependency', 'direct dependencies')} checked` }
        : { label: 'Known vulnerabilities', value: 'not checked', hint: 'offline' },
    ],
    findings,
    measures: [
      { id: 'unsafe-dom-writes', label: 'Direct DOM HTML writes', value: unsafeDom.length },
      { id: 'dynamic-code', label: 'eval and new Function calls', value: dynamicCode.length },
      { id: 'sanitizer-bypasses', label: 'bypassSecurityTrust* calls', value: bypass.length },
      { id: 'inner-html-bindings', label: '[innerHTML] bindings', value: innerHtmlCount },
    ],
  };
}

/** One location per line `pick` returns, across files. */
function sites(files: SourceFileFacts[], pick: (file: SourceFileFacts) => number[]): FileRef[] {
  return files.flatMap((file) => pick(file).map((line) => ({ path: file.path, line })));
}
