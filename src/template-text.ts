/**
 * A template with every HTML comment (`<!-- … -->`) blanked out: each
 * character of the comment becomes a space, line breaks stay, so offsets and
 * line numbers still point at the same places in the file.
 *
 * Template syntax inside a comment does not run, so it must not be counted.
 * Teams comment out markup instead of deleting it; on a 460-template app,
 * all 33 `*ngIf`/`*ngFor` that 0.10.0 reported sat in comments, which graded
 * a codebase fully on built-in control flow as "deprecated control flow in
 * templates". An unterminated `<!--` blanks to the end, as a browser reads it.
 */
export function withoutHtmlComments(text: string): string {
  if (!text.includes('<!--')) return text;
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\n]/g, ' '));
}
