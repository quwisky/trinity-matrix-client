/** deny.toml is the Rust workspace's supply-chain policy; these cases pin what must not loosen. */
import { read } from './workspace-sources.mjs';

// No TOML parser is a direct dependency, so read the sections as text. Comments go first so a
// commented-out setting cannot satisfy a case.
const text = read('deny.toml').replace(/^\s*#.*$/gm, '');
const section = (name) =>
  text.match(
    new RegExp(`^\\[${name}\\]\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm'),
  )?.[1] ?? '';

describe('deny.toml policy', () => {
  it('takes crates from crates.io only, with no git sources', () => {
    const sources = section('sources');
    expect(sources).toMatch(/^unknown-registry = "deny"$/m);
    expect(sources).toMatch(/^unknown-git = "deny"$/m);
    expect(sources).toMatch(
      /^allow-registry = \["https:\/\/github\.com\/rust-lang\/crates\.io-index"\]$/m,
    );
    expect(sources).toMatch(/^allow-git = \[\]$/m);
  });

  it('fails unsound and unmaintained advisories whichever dependency they hit', () => {
    const advisories = section('advisories');
    expect(advisories).toMatch(/^unsound = "all"$/m);
    expect(advisories).toMatch(/^unmaintained = "all"$/m);
  });

  it('ignores exactly one advisory, with the reason it cannot be fixed', () => {
    const ignore = section('advisories').match(
      /^ignore = \[([\s\S]*?)^\]/m,
    )?.[1];
    const entries = ignore?.match(/\{[^}]*\}/g) ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(
      /^\{ id = "RUSTSEC-2026-0319", reason = "[^"]{20,}" \}$/,
    );
    expect(text.match(/RUSTSEC-/g)).toHaveLength(1);
  });

  it('denies wildcard versions and keeps the licence allow list explicit', () => {
    expect(section('bans')).toMatch(/^wildcards = "deny"$/m);
    expect(section('licenses')).toMatch(/^allow = \[/m);
    expect(section('licenses')).not.toMatch(/^exceptions/m);
  });
});
