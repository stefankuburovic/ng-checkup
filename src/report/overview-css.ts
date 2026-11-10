/**
 * Styles of the overview block at the top of the HTML report (direction B,
 * "Executive"). Copied verbatim from the design source,
 * samples/design/overview-b/overview.css in the portfolio repository; edit
 * there and copy back, so the design and the report never drift apart.
 *
 * Every variant shares the markup that `renderOverview` writes; a variant only
 * adds rules under `.ov[data-variant="…"]`. Colours are `--ov-*` tokens.
 */
export const OVERVIEW_STYLES = `
/* ng-checkup report · overview block · direction B ("Executive")
   One stylesheet for every variant. The HTML is identical in all of them;
   a variant only adds rules under .ov[data-variant="…"] (section 9).
   Colours come only from the --ov-* tokens, so a theme is a token swap.
   No images, fonts or scripts: glyphs and bars are drawn with borders,
   which also print when the browser drops background colours. */

/* 1 · Tokens ---------------------------------------------------------- */
:root {
  --ov-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --ov-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --ov-radius: 10px;
  --ov-radius-sm: 6px;
}
:root, [data-theme="light"] {
  color-scheme: light;
  --ov-page: #f7f7f5;
  --ov-surface: #ffffff;
  --ov-text: #1b1d21;
  --ov-muted: #5d636e;
  --ov-border: #e3e3df;
  --ov-border-strong: #b9b9b2;
  --ov-accent: #3b5bdb;
  --ov-on-glyph: #ffffff;
  --ov-track: #e4e4df;
  --ov-good: #1f7a4d;  --ov-good-bg: #e3f3ea;
  --ov-fair: #8a5a00;  --ov-fair-bg: #fbf0d9;
  --ov-poor: #b42318;  --ov-poor-bg: #fde8e6;
  --ov-info: #5d636e;  --ov-info-bg: #ececea;
  --ov-better: #1f7a4d;
  --ov-worse: #b42318;
  --ov-baseline: #1b1d21;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --ov-page: #121316;
    --ov-surface: #1b1d21;
    --ov-text: #ececec;
    --ov-muted: #9aa0aa;
    --ov-border: #2c2f35;
    --ov-border-strong: #4a4f57;
    --ov-accent: #8ea6ff;
    --ov-on-glyph: #121316;
    --ov-track: #30333a;
    --ov-good: #5cc98f;  --ov-good-bg: #173326;
    --ov-fair: #e8b54d;  --ov-fair-bg: #3a2d10;
    --ov-poor: #f17a6e;  --ov-poor-bg: #3d1a17;
    --ov-info: #9aa0aa;  --ov-info-bg: #2a2c31;
    --ov-better: #5cc98f;
    --ov-worse: #f17a6e;
    --ov-baseline: #ececec;
  }
}
[data-theme="dark"] {
  color-scheme: dark;
  --ov-page: #121316;
  --ov-surface: #1b1d21;
  --ov-text: #ececec;
  --ov-muted: #9aa0aa;
  --ov-border: #2c2f35;
  --ov-border-strong: #4a4f57;
  --ov-accent: #8ea6ff;
  --ov-on-glyph: #121316;
  --ov-track: #30333a;
  --ov-good: #5cc98f;  --ov-good-bg: #173326;
  --ov-fair: #e8b54d;  --ov-fair-bg: #3a2d10;
  --ov-poor: #f17a6e;  --ov-poor-bg: #3d1a17;
  --ov-info: #9aa0aa;  --ov-info-bg: #2a2c31;
  --ov-better: #5cc98f;
  --ov-worse: #f17a6e;
  --ov-baseline: #ececec;
}
@media print {
  /* Printing from a dark browser must still give dark ink on white paper. */
  :root, [data-theme] {
    color-scheme: light;
    --ov-page: #ffffff;
    --ov-surface: #ffffff;
    --ov-text: #000000;
    --ov-muted: #3d4148;
    --ov-border: #b9b9b3;
    --ov-border-strong: #6b6b66;
    --ov-accent: #000000;
    --ov-on-glyph: #ffffff;
    --ov-track: #d6d6d0;
    --ov-good: #17603c;  --ov-good-bg: transparent;
    --ov-fair: #6e4800;  --ov-fair-bg: transparent;
    --ov-poor: #9c1c12;  --ov-poor-bg: transparent;
    --ov-info: #3d4148;  --ov-info-bg: transparent;
    --ov-better: #17603c;
    --ov-worse: #9c1c12;
    --ov-baseline: #000000;
  }
}
[data-theme="print"] {
  color-scheme: light;
  --ov-page: #ffffff;
  --ov-surface: #ffffff;
  --ov-text: #000000;
  --ov-muted: #3d4148;
  --ov-border: #b9b9b3;
  --ov-border-strong: #6b6b66;
  --ov-accent: #000000;
  --ov-on-glyph: #ffffff;
  --ov-track: #d6d6d0;
  --ov-good: #17603c;  --ov-good-bg: transparent;
  --ov-fair: #6e4800;  --ov-fair-bg: transparent;
  --ov-poor: #9c1c12;  --ov-poor-bg: transparent;
  --ov-info: #3d4148;  --ov-info-bg: transparent;
  --ov-better: #17603c;
  --ov-worse: #9c1c12;
  --ov-baseline: #000000;
}

/* 2 · Page and block -------------------------------------------------- */
.ov-page {
  margin: 0;
  min-height: 100vh;
  padding: 40px clamp(16px, 4vw, 40px) 56px;
  background: var(--ov-page);
  color: var(--ov-text);
  font-family: var(--ov-font);
  -webkit-font-smoothing: antialiased;
}
.ov {
  max-width: 960px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 28px;
  font-size: 15px;
  line-height: 1.5;
}
.ov, .ov *, .ov *::before, .ov *::after { box-sizing: border-box; }
.ov :where(h1, h2, p, ol, ul, li) { margin: 0; padding: 0; }
.ov :where(ol, ul) { list-style: none; }
.ov :where(.ov-head, .ov-verdict, .ov-score, .ov-areas, .ov-changes, .ov-projects) > * { min-width: 0; }
.ov a { color: inherit; text-decoration: none; }
.ov :is(.ov-area-row, .ov-change):hover :is(.ov-area-name, .ov-change-name),
.ov-project-link:hover .ov-project-name,
a.ov-tally-link:hover .ov-tally-label { text-decoration: underline; }
.ov a:focus-visible { outline: 2px solid var(--ov-accent); outline-offset: 2px; border-radius: 4px; }

/* Stretched links: the whole row is clickable, yet a file link inside it
   stays its own target (no nested <a>). */
.ov-area-row, .ov-change { position: relative; }
.ov :is(.ov-area-name, .ov-change-name)::after { content: ""; position: absolute; inset: 0; }
.ov :is(.ov-area-name, .ov-change-name):focus-visible { outline: none; }
.ov :is(.ov-area-name, .ov-change-name):focus-visible::after { outline: 2px solid var(--ov-accent); outline-offset: -2px; border-radius: 6px; }
.ov-vh {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap;
}

/* 3 · Grade: shape + word, never colour alone (WCAG 1.4.1) ------------ */
.g-good { --g: var(--ov-good); --g-bg: var(--ov-good-bg); }
.g-fair { --g: var(--ov-fair); --g-bg: var(--ov-fair-bg); }
.g-poor { --g: var(--ov-poor); --g-bg: var(--ov-poor-bg); }
.g-info { --g: var(--ov-info); --g-bg: var(--ov-info-bg); }

/* good = filled circle with a tick · fair = diamond with a bar
   poor = square with a cross · info = open ring with an i */
.ov-glyph {
  position: relative; display: inline-block; flex: none;
  width: 0; height: 0;
  border: .5em solid var(--g); border-radius: 50%;
  vertical-align: -.12em;
}
.ov-glyph::before, .ov-glyph::after { content: ""; position: absolute; left: 0; top: 0; }
.g-good .ov-glyph::after {
  width: .24em; height: .46em;
  border: solid var(--ov-on-glyph); border-width: 0 .11em .11em 0;
  transform: translate(-50%, -62%) rotate(45deg);
}
.g-fair .ov-glyph { border-radius: .1em; transform: rotate(45deg) scale(.84); }
.g-fair .ov-glyph::after {
  width: .52em; border-top: .13em solid var(--ov-on-glyph);
  transform: translate(-50%, -50%) rotate(-45deg);
}
.g-poor .ov-glyph { border-radius: .14em; }
.g-poor .ov-glyph::before, .g-poor .ov-glyph::after {
  width: .6em; border-top: .11em solid var(--ov-on-glyph);
  transform: translate(-50%, -50%) rotate(45deg);
}
.g-poor .ov-glyph::after { transform: translate(-50%, -50%) rotate(-45deg); }
.g-info .ov-glyph { width: 1em; height: 1em; border-width: .1em; }
.g-info .ov-glyph::before {
  left: 50%; top: 27%; width: 0; height: 0;
  border: .075em solid var(--g); border-radius: 50%;
  transform: translate(-50%, -50%);
}
.g-info .ov-glyph::after {
  left: 50%; top: 64%; width: 0; height: .34em;
  border-left: .12em solid var(--g);
  transform: translate(-50%, -50%);
}

.ov-grade {
  display: inline-flex; align-items: center; gap: 6px;
  color: var(--g); font-size: 12.5px; font-weight: 650; white-space: nowrap;
}
.ov-grade .ov-glyph { font-size: 13px; }

/* 4 · Change direction: triangle + word; the word decides, not the hue - */
.ov-dir {
  display: inline-block; flex: none; width: 0; height: 0;
  border: .32em solid transparent;
}
[data-dir="better"] .ov-dir { border-top-width: 0; border-bottom: .52em solid currentColor; }
[data-dir="worse"] .ov-dir { border-bottom-width: 0; border-top: .52em solid currentColor; }
:is([data-dir="same"], [data-dir="none"]) .ov-dir { width: .6em; border: 0; border-top: .14em solid currentColor; }
.ov-judge {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 1px 9px 1px 7px;
  border: 1px solid currentColor; border-radius: 999px;
  color: var(--ov-muted); font-size: 12.5px; font-weight: 650; white-space: nowrap;
}
[data-dir="better"] .ov-judge, .ov-area-change[data-dir="better"] { color: var(--ov-better); }
[data-dir="worse"] .ov-judge, .ov-area-change[data-dir="worse"] { color: var(--ov-worse); }

/* 5 · Head ------------------------------------------------------------- */
.ov-head { display: flex; flex-direction: column; gap: 4px; }
.ov-eyebrow { color: var(--ov-accent); font-size: 12.5px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; }
.ov-title { font-size: clamp(24px, 3.4vw, 32px); line-height: 1.15; font-weight: 700; letter-spacing: -.01em; overflow-wrap: anywhere; }
.ov-meta, .ov-dates { color: var(--ov-muted); font-size: 13.5px; overflow-wrap: anywhere; }

/* 6 · Verdict: score, band, delta, scale, coverage, sentence, tally ---- */
.ov-verdict {
  display: grid;
  grid-template-columns: minmax(0, 300px) minmax(0, 1fr);
  grid-template-rows: auto 1fr;
  gap: 20px 40px;
  padding: 24px 28px;
  background: var(--ov-surface);
  border: 1px solid var(--ov-border);
  border-radius: var(--ov-radius);
}
.ov-score { grid-row: 1 / span 2; display: flex; flex-direction: column; gap: 8px; }
.ov-score-num { display: flex; align-items: baseline; gap: 4px; font-variant-numeric: tabular-nums; }
.ov-score-value { font-size: 72px; font-weight: 750; line-height: .9; letter-spacing: -.035em; }
.ov-score-max { color: var(--ov-muted); font-size: 18px; }
.ov-band { display: flex; align-items: center; gap: 8px; color: var(--g); font-size: 18px; font-weight: 700; }
.ov-band .ov-glyph { font-size: 18px; }
.ov-delta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; color: var(--ov-muted); font-size: 13.5px; font-variant-numeric: tabular-nums; }
.ov-scale { position: relative; height: 32px; margin-top: 6px; }
.ov-scale-track, .ov-scale-fill {
  position: absolute; left: 0; top: 6px; height: 0;
  border-top: 8px solid var(--ov-track); border-radius: 999px;
}
.ov-scale-track { right: 0; }
.ov-scale-fill { min-width: 8px; border-top-color: var(--g); }
.ov-scale-base { position: absolute; top: 0; height: 20px; border-left: 2px solid var(--ov-baseline); transform: translateX(-1px); }
.ov-scale-tick { position: absolute; top: 19px; transform: translateX(-50%); color: var(--ov-muted); font-size: 11px; line-height: 1; font-variant-numeric: tabular-nums; }
.ov-coverage { color: var(--ov-muted); font-size: 13px; }
.ov-summary { align-self: end; max-width: 46ch; font-size: 19px; line-height: 1.45; text-wrap: pretty; }
.ov-tally { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; align-self: start; }
.ov-tally-item {
  background: var(--g-bg);
  border: 1px solid var(--ov-border); border-radius: var(--ov-radius-sm);
}
/* Glyph, count and word on one row: count and word share a baseline, the glyph
   is centred on that row, and the row is centred in the card (align-content),
   so cards of any height in the same grid row still line up. */
.ov-tally-link {
  display: grid; grid-template-columns: auto auto minmax(0, 1fr);
  align-items: baseline; align-content: center; column-gap: 8px;
  height: 100%; padding: 12px 14px; border-radius: inherit;
}
a.ov-tally-link:hover { box-shadow: inset 0 0 0 1px var(--g); }
.ov-tally-item .ov-glyph { align-self: center; font-size: 18px; }
.ov-tally-count { font-size: 22px; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; }
.ov-tally-label { min-width: 0; color: var(--ov-muted); font-size: 13px; line-height: 1.3; }
.ov-tally-item[data-count="0"] { background: transparent; }
.ov-tally-item[data-count="0"] .ov-tally-count { color: var(--ov-muted); font-weight: 500; }

/* Fewer than 5 graded areas: the number is a rough signal, say so. */
.ov[data-coverage="low"] .ov-score-value { color: var(--ov-muted); }
.ov[data-coverage="low"] .ov-scale-fill { border-top-style: dashed; }
.ov[data-coverage="low"] .ov-coverage {
  padding: 6px 10px;
  color: var(--ov-text); font-weight: 600;
  border: 1px solid var(--ov-border-strong); border-radius: var(--ov-radius-sm);
}

/* 7 · Sections: projects, areas, changes ------------------------------- */
.ov-section-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px; margin-bottom: 10px; }
.ov-h2 { color: var(--ov-muted); font-size: 13px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; }
.ov-aside { color: var(--ov-muted); font-size: 13px; font-variant-numeric: tabular-nums; }

.ov-area-list, .ov-project-list {
  columns: 3 240px; column-gap: 32px;
  padding: 4px 20px;
  background: var(--ov-surface);
  border: 1px solid var(--ov-border); border-radius: var(--ov-radius);
}
.ov-area, .ov-project { break-inside: avoid; border-bottom: 1px solid var(--ov-border); }
.ov-area-row {
  display: grid; grid-template-columns: 4.75rem minmax(0, 1fr) auto;
  align-items: baseline; column-gap: 10px; row-gap: 2px;
  padding: 9px 0;
}
.ov-area-name { font-size: 14.5px; font-weight: 550; overflow-wrap: anywhere; }
.ov-area.g-info .ov-area-name { color: var(--ov-muted); font-weight: 400; }
.ov-area { scroll-margin-top: 24px; }
/* A tally link targets the first area of its grade; tint that whole grade group. */
.ov:has(.ov-area.g-poor:target) .ov-area.g-poor,
.ov:has(.ov-area.g-fair:target) .ov-area.g-fair,
.ov:has(.ov-area.g-good:target) .ov-area.g-good,
.ov:has(.ov-area.g-info:target) .ov-area.g-info { background: var(--g-bg); }
.ov-area-note { display: none; grid-column: 2 / -1; color: var(--ov-muted); font-size: 13.5px; overflow-wrap: anywhere; }
.ov-area-change {
  grid-column: 3; grid-row: 1;
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 12px; font-weight: 650; white-space: nowrap;
}

.ov-project-link {
  display: grid; grid-template-columns: 4.75rem minmax(0, 1fr) 3ch;
  align-items: baseline; column-gap: 10px; row-gap: 6px;
  padding: 9px 0 11px;
}
.ov-project-name { font-size: 13px; }
.ov-project-score { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
.ov-project-bar { grid-column: 1 / -1; position: relative; height: 0; border-top: 4px solid var(--ov-track); border-radius: 999px; }
.ov-project-fill { position: absolute; left: 0; top: -4px; height: 0; min-width: 4px; border-top: 4px solid var(--g); border-radius: 999px; }

/* Columns are shared by every row (subgrid), so 9 → 12 and 1 204 → 1 504 line up. */
.ov-change-list {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 12rem) max-content max-content max-content;
  column-gap: 20px;
  padding: 4px 20px;
  background: var(--ov-surface);
  border: 1px solid var(--ov-border); border-radius: var(--ov-radius);
}
.ov-change, .ov-change-more { grid-column: 1 / -1; }
.ov-change {
  display: grid; grid-template-columns: subgrid; align-items: baseline;
  padding: 10px 0;
  border-bottom: 1px solid var(--ov-border);
  font-variant-numeric: tabular-nums;
}
.ov-change:last-child { border-bottom: 0; }
.ov-change-name { font-weight: 550; overflow-wrap: anywhere; }
.ov-change-area { color: var(--ov-muted); font-size: 13.5px; overflow-wrap: anywhere; }
.ov-change-values { color: var(--ov-muted); text-align: right; white-space: nowrap; }
.ov-now { color: var(--ov-text); font-weight: 600; }
.ov-arrow { margin: 0 .35em; }
.ov-change-diff { text-align: right; font-weight: 600; white-space: nowrap; }
.ov-change .ov-judge { justify-self: start; }
.ov-change-more { padding: 10px 0; font-size: 13.5px; }
.ov-change-more a { color: var(--ov-accent); text-decoration: underline; text-underline-offset: 2px; }
.ov-empty {
  padding: 16px 20px;
  color: var(--ov-muted);
  background: var(--ov-surface);
  border: 1px dashed var(--ov-border-strong); border-radius: var(--ov-radius);
}

/* Paths: break after each slash (the generator adds <wbr>), dim the folder,
   keep the file name strong so the readable end survives any wrap. */
.ov-path { font-family: var(--ov-mono); font-size: .9em; overflow-wrap: anywhere; }
.ov-area-note .ov-path { margin-left: .3em; }
/* File links open in the editor (vscode://file/…:line by default). */
a.ov-path {
  position: relative; z-index: 1;
  text-decoration: underline dotted; text-decoration-color: var(--ov-border-strong); text-underline-offset: 3px;
}
a.ov-path:hover { text-decoration-style: solid; text-decoration-color: currentColor; }
a.ov-path:hover .ov-path-dir { color: var(--ov-text); }
.ov-path-dir { color: var(--ov-muted); }
.ov-path-file { color: var(--ov-text); font-weight: 600; }

/* 8 · Narrow screens ---------------------------------------------------- */
@media (max-width: 760px) {
  .ov-verdict { grid-template-columns: minmax(0, 1fr); padding: 20px; }
  .ov-score { grid-row: auto; }
  .ov-score-value { font-size: 56px; }
  .ov-summary { font-size: 17px; }
  .ov-tally { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 560px) {
  .ov-change-list { grid-template-columns: minmax(0, 1fr) max-content; padding: 4px 16px; }
  .ov-change { row-gap: 4px; }
  .ov-change-name { grid-column: 1; grid-row: 1; }
  .ov-change .ov-judge { grid-column: 2; grid-row: 1; }
  .ov-change-area { grid-column: 1; grid-row: 2; }
  .ov-change-values { grid-column: 1; grid-row: 3; text-align: left; }
  .ov-change-diff { grid-column: 2; grid-row: 3; }
}

/* 9 · Variants: CSS only, same HTML ------------------------------------ */

/* A · Ledger: one row per area with its note; grade groups ruled. */
.ov[data-variant="ledger"] .ov-verdict { grid-template-columns: minmax(0, 240px) minmax(0, 1fr); }
.ov[data-variant="ledger"] .ov-score-value { font-size: 56px; }
.ov[data-variant="ledger"] .ov-area-list { columns: auto; padding: 0; }
.ov[data-variant="ledger"] .ov-area-row { grid-template-columns: 5.5rem minmax(0, 15rem) minmax(0, 1fr) auto; padding: 10px 20px; }
.ov[data-variant="ledger"] .ov-area-note { display: block; grid-column: 3; grid-row: 1; }
.ov[data-variant="ledger"] .ov-area-change { grid-column: 4; }
.ov[data-variant="ledger"] .ov-area:last-child { border-bottom: 0; }
.ov[data-variant="ledger"] .ov-area:is(:nth-child(1 of .g-fair), :nth-child(1 of .g-good), :nth-child(1 of .g-info)):not(:first-child) { border-top: 2px solid var(--ov-border-strong); }
@media (max-width: 760px) {
  .ov[data-variant="ledger"] .ov-area-row { grid-template-columns: 5.5rem minmax(0, 1fr) auto; padding: 10px 16px; }
  .ov[data-variant="ledger"] .ov-area-note { grid-column: 2 / -1; grid-row: 2; }
  .ov[data-variant="ledger"] .ov-area-change { grid-column: 3; }
}

/* B · Tiles: 15 tiles in a 5 × 3 grid; the tally shrinks to a legend. */
.ov[data-variant="tiles"] .ov-tally { display: flex; flex-wrap: wrap; gap: 6px 20px; }
.ov[data-variant="tiles"] .ov-tally-item { background: none; border: 0; }
.ov[data-variant="tiles"] .ov-tally-link { gap: 6px; padding: 0; }
.ov[data-variant="tiles"] .ov-tally-item .ov-glyph { font-size: 14px; }
.ov[data-variant="tiles"] .ov-tally-count { font-size: 16px; }
.ov[data-variant="tiles"] .ov-area-list { columns: auto; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; padding: 0; background: none; border: 0; }
.ov[data-variant="tiles"] .ov-area { border: 0; }
.ov[data-variant="tiles"] .ov-area-row {
  height: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 8px;
  padding: 14px;
  background: var(--ov-surface);
  border: 1px solid var(--ov-border); border-top: 4px solid var(--g); border-radius: var(--ov-radius-sm);
}
.ov[data-variant="tiles"] .ov-grade .ov-glyph { font-size: 18px; }
.ov[data-variant="tiles"] .ov-area-name { font-size: 14px; line-height: 1.3; }
.ov[data-variant="tiles"] .ov-area-change { margin-top: auto; }
@media (max-width: 900px) { .ov[data-variant="tiles"] .ov-area-list { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 560px) { .ov[data-variant="tiles"] .ov-area-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } }

/* C · Columns: the tally becomes four column heads, areas drop into their grade's column. */
.ov[data-variant="columns"] .ov-verdict { grid-template-columns: minmax(0, 260px) minmax(0, 1fr); grid-template-rows: auto auto; padding: 0; background: none; border: 0; }
.ov[data-variant="columns"] .ov-score { grid-row: auto; }
.ov[data-variant="columns"] .ov-tally { grid-column: 1 / -1; gap: 12px; }
.ov[data-variant="columns"] .ov-tally-item { background: none; border: 0; border-bottom: 3px solid var(--g); border-radius: 0; }
.ov[data-variant="columns"] .ov-tally-link { padding: 8px 2px 10px; }
.ov[data-variant="columns"] .ov-areas { margin-top: -14px; }
.ov[data-variant="columns"] .ov-areas .ov-section-head { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.ov[data-variant="columns"] .ov-area-list { columns: auto; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); grid-auto-flow: row dense; gap: 8px 12px; padding: 0; background: none; border: 0; }
.ov[data-variant="columns"] .ov-area { border: 0; }
.ov[data-variant="columns"] .ov-area.g-poor { grid-column: 1; }
.ov[data-variant="columns"] .ov-area.g-fair { grid-column: 2; }
.ov[data-variant="columns"] .ov-area.g-good { grid-column: 3; }
.ov[data-variant="columns"] .ov-area.g-info { grid-column: 4; }
.ov[data-variant="columns"] .ov-area-row {
  height: 100%; grid-template-columns: minmax(0, 1fr) auto; row-gap: 4px;
  padding: 10px 12px;
  background: var(--ov-surface);
  border: 1px solid var(--ov-border); border-radius: var(--ov-radius-sm);
}
.ov[data-variant="columns"] .ov-grade { grid-column: 1; grid-row: 1; }
.ov[data-variant="columns"] .ov-area-name { grid-column: 1 / -1; grid-row: 2; font-size: 14px; line-height: 1.35; }
.ov[data-variant="columns"] .ov-area-change { grid-column: 2; grid-row: 1; }
@media (max-width: 760px) {
  .ov[data-variant="columns"] .ov-verdict { grid-template-columns: minmax(0, 1fr); }
  .ov[data-variant="columns"] .ov-areas { margin-top: 0; }
  .ov[data-variant="columns"] .ov-area-list { grid-template-columns: minmax(0, 1fr); }
  .ov[data-variant="columns"] .ov-area:is(.g-poor, .g-fair, .g-good, .g-info) { grid-column: auto; }
}

/* D · Changes first: what moved since the baseline leads; areas become chips. */
.ov[data-variant="changes"] .ov-changes { order: 1; }
.ov[data-variant="changes"] .ov-projects { order: 2; }
.ov[data-variant="changes"] .ov-areas { order: 3; }
.ov[data-variant="changes"] .ov-verdict { grid-template-columns: auto minmax(0, 1fr); grid-template-rows: auto; align-items: center; gap: 14px 32px; padding: 18px 24px; }
.ov[data-variant="changes"] .ov-score { grid-row: auto; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 4px 14px; max-width: 360px; }
.ov[data-variant="changes"] .ov-score-value { font-size: 44px; }
.ov[data-variant="changes"] .ov-scale { display: none; }
.ov[data-variant="changes"] .ov-coverage { flex-basis: 100%; }
.ov[data-variant="changes"] .ov-summary { align-self: center; font-size: 16px; }
.ov[data-variant="changes"] .ov-tally { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 6px 20px; }
.ov[data-variant="changes"] .ov-tally-item { background: none; border: 0; }
.ov[data-variant="changes"] .ov-tally-link { gap: 6px; padding: 0; }
.ov[data-variant="changes"] .ov-tally-item .ov-glyph { font-size: 14px; }
.ov[data-variant="changes"] .ov-tally-count { font-size: 16px; }
.ov[data-variant="changes"] .ov-change-list { padding: 6px 24px; }
.ov[data-variant="changes"] .ov-change { padding: 13px 0; font-size: 16px; }
.ov[data-variant="changes"] .ov-area-list { columns: auto; display: flex; flex-wrap: wrap; gap: 8px; padding: 0; background: none; border: 0; }
.ov[data-variant="changes"] .ov-area { border: 0; }
.ov[data-variant="changes"] .ov-area-row {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 5px 12px 5px 10px;
  background: var(--ov-surface);
  border: 1px solid var(--ov-border); border-radius: 999px;
}
.ov[data-variant="changes"] .ov-grade-word { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.ov[data-variant="changes"] .ov-area-name { font-size: 13.5px; }
.ov[data-variant="changes"] .ov-area-change { font-size: 11.5px; }
@media (max-width: 760px) {
  .ov[data-variant="changes"] .ov-verdict { grid-template-columns: minmax(0, 1fr); }
}

/* 10 · Print: the overview is page 1 of the PDF ----------------------- */
@page { margin: 14mm; }
@media print {
  .ov-page { min-height: 0; padding: 0; }
  .ov { max-width: none; gap: 16pt; font-size: 10pt; break-after: page; }
  .ov-verdict, .ov-areas, .ov-changes, .ov-projects { break-inside: avoid; }
  .ov-score-value { font-size: 44pt; }
  .ov-summary { font-size: 13pt; }
  .ov-area-list, .ov-project-list { columns: 3 150px; }
  .ov a:hover :is(.ov-area-name, .ov-project-name) { text-decoration: none; }
}
/* Same rules for the on-screen print preview (data-theme="print"). */
[data-theme="print"].ov-page { padding: 54px; }
[data-theme="print"] .ov { max-width: none; gap: 20px; font-size: 13px; }
[data-theme="print"] .ov-score-value { font-size: 58px; }
[data-theme="print"] .ov-summary { font-size: 17px; }
[data-theme="print"] .ov-area-list, [data-theme="print"] .ov-project-list { columns: 3 150px; }
`;
