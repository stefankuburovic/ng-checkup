/**
 * The consultant's notes for a client report, written in Markdown, as HTML.
 *
 * Covers what such notes use: `##`/`###` headings, paragraphs, `-` and `1.`
 * lists, pipe tables, `**bold**`, `*italic*`, `` `code` `` and `[links](url)`.
 * HTML comments are dropped, so the guidance in the generated template never
 * reaches the client. Everything is escaped first and only those constructs
 * are turned back into tags, so a note can never inject markup into the
 * report; a link is kept only for http(s) and mailto URLs.
 */
export function renderNotes(markdown: string): string {
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;
  let table: string[][] | undefined;

  const flush = (): void => {
    if (paragraph.length > 0) html.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
    if (list) html.push(`<${list.ordered ? 'ol' : 'ul'}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${list.ordered ? 'ol' : 'ul'}>`);
    list = undefined;
    if (table) html.push(renderTable(table));
    table = undefined;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (line.trim() === '') {
      flush();
    } else if (heading) {
      flush();
      // `#` and `##` both become the section's own level below the report's h2.
      const level = Math.min(4, Math.max(3, heading[1]!.length + 1));
      html.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      if (paragraph.length > 0 || list) flush();
      const cells = line.trim().slice(1, -1).split('|').map((cell) => cell.trim());
      if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue; // the header separator
      (table ??= []).push(cells);
    } else if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (paragraph.length > 0 || table || (list && list.ordered !== ordered)) flush();
      (list ??= { ordered, items: [] }).items.push((bullet ?? numbered)![1]!);
    } else if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`; // a wrapped list item
    } else {
      if (list || table) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  // A heading with nothing under it before the next heading is a template
  // section the consultant left empty; it is dropped rather than shown bare.
  return html.filter((block, index) => !/^<h\d/.test(block) || (index + 1 < html.length && !/^<h\d/.test(html[index + 1]!))).join('\n');
}

/** A pipe table; the first row is the header. Rows with empty cells stay, since an unfilled estimate is information too. */
function renderTable(rows: string[][]): string {
  const [head, ...body] = rows;
  return `<div class="table-wrap"><table class="projects">
      <thead><tr>${head!.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead>
      <tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
}

/** Inline Markdown on escaped text. */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

/** HTML-escapes text for element content and double-quoted attributes. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * A starting point for the consultant's notes, prefilled from the report:
 * one row per AngularJS migration phase and per upgrade step with what it
 * involves, and an empty column for the
 * estimate, which only the consultant can fill. Guidance is in HTML comments,
 * which `renderNotes` drops, so a section left as it is renders as nothing
 * rather than as instructions the client should not see.
 */
export function notesTemplate(report: import('../types.js').Report): string {
  const plan = report.plan;
  const rows: string[] = [];
  for (const [index, phase] of (report.migration?.phases ?? []).entries()) rows.push(`| ${index + 1}. ${phase.title} | ${phase.items.map((item) => cellText(item.title, item.count)).join('; ')} | |`);
  if (plan && plan.before.length > 0) rows.push(`| Before the upgrade | ${plan.before.map((item) => cellText(item.title, item.count)).join('; ')} | |`);
  for (const step of plan?.steps ?? []) {
    const work = step.items.map((item) => cellText(item.title, item.count));
    rows.push(`| Angular ${step.to} | ${['`ng update`', ...work].join('; ')} | |`);
  }
  const lines = [
    `<!-- Notes for the ${report.client?.name ?? 'client'} Health Check. Everything in comments like this one is left out of the report. -->`,
    '',
    '## Summary',
    '',
    '<!-- Two or three sentences for management: where the codebase stands, what you recommend, and what it buys them. -->',
    '',
  ];
  if (rows.length > 0) {
    lines.push('## Recommended plan', '', '<!-- One row per phase. Fill in the estimate (days); merge or drop rows as you see fit. -->', '', '| Phase | Scope | Estimate |', '| --- | --- | --- |', ...rows, '');
  }
  lines.push('## What else to address', '', '<!-- The findings worth doing outside the upgrade itself, in the order you recommend. -->', '', '## Pricing', '', '<!-- Fixed price or day rate, what is included and what is not. -->', '', '## Next steps', '', '<!-- What happens after this report, and who does what. -->', '');
  return lines.join('\n');
}

/** A plan item for a table cell: its title with the count, and no pipe that would split the cell. */
function cellText(title: string, count?: number): string {
  return `${title.replace(/\|/g, '/')}${count !== undefined ? ` (${count})` : ''}`;
}
