#!/usr/bin/env node
/**
 * Select and run the checks a change needs.
 *
 *   node .agents/skills/validate-change/validate-change.mjs          # print the plan
 *   node .agents/skills/validate-change/validate-change.mjs --run    # run it, stop nothing early
 *   ... --base origin/release/0.2.x                                  # another comparison base
 *
 * Changed files = `git diff --name-only <base>...HEAD` plus staged, unstaged and untracked files.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'origin/main';
const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
const git = (...a) =>
  spawnSync('git', a, { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);

const files = [
  ...new Set([
    ...git('diff', '--name-only', `${base}...HEAD`),
    ...git('diff', '--name-only', 'HEAD'),
    ...git('ls-files', '--others', '--exclude-standard'),
  ]),
].sort();

if (files.length === 0) {
  console.log(`No changes against ${base}.`);
  process.exit(0);
}

const any = (re) => files.some((f) => re.test(f));
const docsOnly = files.every((f) => /^apps\/docs-(users|developers)\/src\/content\/docs\/.*\.md$/.test(f));
const checks = [];
const notes = [];

if (!docsOnly) {
  checks.push(['affected typecheck, lint, test', `pnpm nx affected -t typecheck lint test --base=${base} --exclude=scripts`]);
  // Repository contracts (design system, styling, docs, CI, catalog) live in the scripts suite
  // and inspect the whole tree, so Nx's project graph does not mark them affected.
  checks.push(['repository contract tests', 'pnpm nx test scripts']);
}
checks.push(['formatting', 'pnpm format:check']);
if (any(/^(apps|libs|e2e|electron|architecture)\/|^(package\.json|pnpm-lock\.yaml|tsconfig\.base\.json)$|project\.json$/)) {
  checks.push(['architecture contracts', 'pnpm architecture:check']);
}
if (any(/\.(scss|css)$/) || any(/^(\.stylelintrc\.json|stylelint-suppressions\.json)$/)) {
  checks.push(['stylelint', 'pnpm stylelint']);
}
if (any(/^apps\/docs-|^tools\/docs\//)) {
  checks.push(['documentation site', 'pnpm nx run docs-site:check']);
  notes.push('Docs headings need explicit {#id} anchors; docs-site:check rejects ones without.');
}
if (any(/(^|\/)package\.json$|^pnpm-lock\.yaml$|(^|\/)project\.json$/)) {
  notes.push(
    'Dependencies or project wiring changed: run `pnpm architecture:map` and commit docs-internal/architecture/dependency-map.md if it changes.',
  );
}

// Browser journeys by capability folder: a changed journey, or a source path naming the capability.
const journeysDir = join(root, 'e2e/browser/journeys');
const capabilityHints = {
  accounts: /auth|account|login|sso|session/,
  conversations: /message|composer|thread|conversation|timeline|media|voice|reaction|poll/,
  'discovery-search': /search|discover|explore|directory/,
  'host-shell': /shell|host|electron|title-row|platform/,
  identity: /identity|profile|avatar|presence/,
  notifications: /notification|push|badge|unread/,
  'room-administration': /room-settings|administration|member|permission|power-level|invite/,
  'room-library': /room-library|room-list|channel-sidebar|server-rail|room-row|space/,
  settings: /settings|appearance|theme|preference/,
  trust: /crypto|trust|verif|encrypt|backup|recovery|device/,
  workspace: /workspace|navigation|runtime|layout|dialog|sheet|overlay/,
};
const capabilities = readdirSync(journeysDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((cap) =>
    files.some(
      (f) =>
        f.startsWith(`e2e/browser/journeys/${cap}/`) ||
        (/^(apps\/trinity|libs)\//.test(f) && (capabilityHints[cap] ?? new RegExp(cap)).test(f)),
    ),
  );

console.log(`Changed files against ${base} (+ working tree): ${files.length}`);
console.log('\nChecks:');
for (const [name, cmd] of checks) console.log(`  - ${name}: ${cmd}`);
if (capabilities.length) {
  console.log('\nBrowser journeys to run (homeserver-backed, one at a time — they share ports):');
  for (const cap of capabilities) console.log(`  - pnpm nx run trinity-e2e-browser:e2e -- ${cap}/`);
}
if (notes.length) console.log(`\nNotes:\n${notes.map((n) => `  - ${n}`).join('\n')}`);

if (!args.includes('--run')) process.exit(0);

const results = checks.map(([name, cmd]) => {
  console.log(`\n=== ${name}: ${cmd}`);
  const { status } = spawnSync(cmd, { cwd: root, shell: true, stdio: 'inherit' });
  return [name, cmd, status];
});
console.log('\nSummary:');
for (const [name, cmd, status] of results) console.log(`  ${status === 0 ? 'PASS' : 'FAIL'} (${status}) ${name}: ${cmd}`);
process.exit(results.some(([, , status]) => status !== 0) ? 1 : 0);
