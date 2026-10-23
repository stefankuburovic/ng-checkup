/**
 * HTML escaping for every HTML renderer. A module of its own so that the
 * chart module can use it without importing the full report renderer, which
 * imports the charts in turn.
 */

/** HTML-escapes text for element content and double-quoted attributes. */
export function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
