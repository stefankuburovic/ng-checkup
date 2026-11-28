// Downloads, at image build time, the typings ng-checkup reads for the
// deprecated-APIs area: the newest stable release of each of the last three
// Angular majors, for the packages most code imports, and the newest RxJS 7.
// Kept under NG_CHECKUP_CACHE exactly as an online run would keep them, so an
// --offline run finds them. Only .d.ts files and manifests are written.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
const { packageTypings } = await import(pathToFileURL(join(root, 'ng-checkup-cli', 'dist', 'package-store.js')).href);

const ANGULAR = ['@angular/core', '@angular/common', '@angular/router', '@angular/forms', '@angular/platform-browser', '@angular/animations'];

async function stableVersions(name) {
  const response = await fetch(`https://registry.npmjs.org/${name}`, { headers: { accept: 'application/vnd.npm.install-v1+json' } });
  if (!response.ok) throw new Error(`${name}: registry answered ${response.status}`);
  const document = await response.json();
  return { latest: document['dist-tags'].latest, versions: Object.keys(document.versions).filter((version) => /^\d+\.\d+\.\d+$/.test(version)) };
}

const newest = (versions) => versions.sort((left, right) => left.localeCompare(right, undefined, { numeric: true })).at(-1);

const core = await stableVersions('@angular/core');
const latestMajor = Number(core.latest.split('.')[0]);
const wanted = [];
for (const major of [latestMajor, latestMajor - 1, latestMajor - 2]) {
  const version = newest(core.versions.filter((candidate) => candidate.startsWith(`${major}.`)));
  if (version) for (const name of ANGULAR) wanted.push([name, version]);
}
const rxjs = await stableVersions('rxjs');
wanted.push(['rxjs', newest(rxjs.versions.filter((version) => version.startsWith('7.')))]);

let failed = 0;
for (const [name, version] of wanted) {
  const directory = await packageTypings(name, version);
  process.stdout.write(`${directory ? 'cached ' : 'MISSING'} ${name}@${version}\n`);
  if (!directory) failed++;
}
if (failed > 0) process.exit(1);
