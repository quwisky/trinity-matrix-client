/** The Homebrew cask is generated whole, so its exact shape is the contract. */
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { renderCask } from './homebrew-cask.mjs';

const SHA = 'a'.repeat(64);

describe('Homebrew cask', () => {
  it('renders the stable cask against the GitHub release asset', () => {
    expect(renderCask({ cask: 'trinity', version: '0.2.0', sha256: SHA }))
      .toBe(`cask "trinity" do
  version "0.2.0"
  sha256 "${SHA}"

  url "https://github.com/quwisky/trinity-matrix-client/releases/download/v#{version}/Trinity-#{version}-arm64-mac.zip"
  name "Trinity"
  desc "End-to-end encrypted Matrix client"
  homepage "https://github.com/quwisky/trinity-matrix-client"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on macos: :ventura

  app "Trinity.app"

  zap trash: [
    "~/Library/Application Support/Trinity",
    "~/Library/Caches/dev.trinityproject.trinity",
    "~/Library/Logs/Trinity",
    "~/Library/Preferences/dev.trinityproject.trinity.plist",
    "~/Library/Saved Application State/dev.trinityproject.trinity.savedState",
  ]
end
`);
  });

  it('renders the prerelease cask as Trinity Next, installable beside stable', () => {
    const cask = renderCask({
      cask: 'trinity@next',
      version: '0.2.0-next.3',
      sha256: SHA,
    });
    expect(cask).toMatch(/^cask "trinity@next" do\n/);
    expect(cask).toContain('  version "0.2.0-next.3"\n');
    expect(cask).toContain(
      '  url "https://github.com/quwisky/trinity-matrix-client/releases/download/v#{version}/Trinity-#{version}-arm64-mac.zip"\n',
    );
    expect(cask).toContain('  name "Trinity Next"\n');
    expect(cask).toContain('  app "Trinity Next.app"\n');
    expect(cask).not.toContain('conflicts_with');
    // Zap removes only Trinity Next's own data, never stable Trinity's.
    expect(cask).toContain(
      '  zap trash: [\n    "~/Library/Application Support/Trinity Next",\n    "~/Library/Caches/dev.trinityproject.trinity.next",\n    "~/Library/Logs/Trinity Next",\n    "~/Library/Preferences/dev.trinityproject.trinity.next.plist",\n    "~/Library/Saved Application State/dev.trinityproject.trinity.next.savedState",\n  ]\n',
    );
    // Without its own livecheck, Homebrew would compare against stable tags too.
    expect(cask).toContain(
      '  livecheck do\n    url :url\n    regex(/^v?(\\d+(?:\\.\\d+)+-next\\.\\d+)$/i)\n    strategy :git\n  end\n',
    );
  });

  it.each([
    [{ cask: 'trinity@beta', version: '0.2.0', sha256: SHA }, /Unknown cask/],
    [{ cask: 'trinity', version: '0.2.0-next.1', sha256: SHA }, /does not fit/],
    [{ cask: 'trinity@next', version: '0.2.0', sha256: SHA }, /does not fit/],
    [{ cask: 'trinity', version: 'v0.2.0', sha256: SHA }, /does not fit/],
    [{ cask: 'trinity', version: '0.2.0', sha256: 'A'.repeat(64) }, /sha256/],
    [{ cask: 'trinity', version: '0.2.0', sha256: 'a'.repeat(63) }, /sha256/],
  ])('rejects %o', (input, message) => {
    expect(() => renderCask(input)).toThrow(message);
  });

  it('prints the cask from the command line', () => {
    const out = execFileSync(
      process.execPath,
      [
        resolve(import.meta.dirname, 'homebrew-cask.mjs'),
        '--cask',
        'trinity',
        '--version',
        '0.2.0',
        '--sha256',
        SHA,
      ],
      { encoding: 'utf8' },
    );
    expect(out).toBe(
      renderCask({ cask: 'trinity', version: '0.2.0', sha256: SHA }),
    );
  });

  it('can be imported without a script entry point', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(resolve(import.meta.dirname, 'homebrew-cask.mjs'))}); process.stdout.write(typeof m.renderCask);`,
      ],
      { encoding: 'utf8' },
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('function');
  });
});
