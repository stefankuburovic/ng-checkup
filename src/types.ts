/**
 * The shapes every check produces and every report renderer consumes.
 *
 * Kept in one dependency-free file so the renderers never import a check and a
 * check never imports a renderer: a check only describes what it found, and the
 * terminal, Markdown, HTML and JSON outputs decide independently how to show it.
 */

/**
 * How a check judges the area it looked at.
 *
 * `info` means the check had nothing to grade, either because the codebase has
 * none of what it measures (no components, no tests) or because a required
 * input was missing (no `node_modules`). It never counts against the codebase.
 */
export type Grade = 'good' | 'fair' | 'poor' | 'info';

/**
 * How urgent a single finding is. `high` findings are lifted into the
 * "top priorities" list at the head of every report.
 */
export type Severity = 'high' | 'medium' | 'low' | 'info';

/** A source location, relative to the analysed root and always with `/` separators. */
export interface FileRef {
  path: string;
  /** 1-based; absent when the finding concerns the file as a whole. */
  line?: number;
}

/** One headline number shown in a check's metric grid. */
export interface Metric {
  label: string;
  value: string | number;
  /** A short qualifier rendered under the value, such as "of 214 components". */
  hint?: string;
}

/** One thing a check wants a reader to act on, or at least to know. */
export interface Finding {
  severity: Severity;
  /** One line, readable without the detail. Backticks mark code, as in Markdown; nothing else is markup. */
  message: string;
  /** Why it matters and what fixing it involves. Same markup rule as `message`. */
  detail?: string;
  /**
   * Example locations, already capped at `maxExamples`. `count` holds the real
   * total, so a renderer can say "and 40 more".
   */
  files?: FileRef[];
  count?: number;
}

/** What one check returns. */
export interface CheckResult {
  /** Stable machine id, used by `--fail-on` and in the JSON output. */
  id: string;
  title: string;
  grade: Grade;
  /** One sentence shown next to the grade in every format. */
  summary: string;
  metrics: Metric[];
  findings: Finding[];
}

/** The `ng-checkup` result as a whole, which is also the JSON output schema. */
export interface Report {
  tool: { name: string; version: string };
  /** ISO 8601. */
  generatedAt: string;
  root: string;
  project: {
    name: string;
    kind: WorkspaceKind;
    angularVersion?: string;
    sourceFiles: number;
    templateFiles: number;
    linesOfCode: number;
  };
  checks: CheckResult[];
  durationMs: number;
}

/**
 * How the repository is organised. It decides where project configuration is
 * read from: `angular.json` for the Angular CLI, the `project.json` files for
 * Nx. A repository with neither is still analysed, its builders are just unknown.
 */
export type WorkspaceKind = 'angular-cli' | 'nx' | 'unknown';

/** Options shared by the CLI and the programmatic API. */
export interface CheckupOptions {
  /**
   * Skip the npm registry lookup of the latest Angular version. The version
   * check then compares against the newest major this release of the tool
   * knows about and says so.
   */
  offline?: boolean;
  /** How many example locations a finding lists. Defaults to 5. */
  maxExamples?: number;
  /** Paths to leave out, as in the config file's `ignore` (see `ignoreMatcher`). */
  ignore?: string[];
}
