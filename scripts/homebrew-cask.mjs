/** Render the Homebrew cask for one published Trinity release (see the release guide). */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = 'https://github.com/quwisky/trinity-matrix-client';
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NEXT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-next\.(0|[1-9]\d*)$/;
// Each cask watches only its own line; without these, Homebrew's livecheck would read every
// git tag and compare a stable cask against -next tags (or the reverse).
const LIVECHECK = {
  stable: '    url :url\n    strategy :github_latest\n',
  next: '    url :url\n    regex(/^v?(\\d+(?:\\.\\d+)+-next\\.\\d+)$/i)\n    strategy :git\n',
};
const CASKS = {
  trinity: {
    name: 'Trinity',
    conflicts: 'trinity@next',
    version: STABLE,
    livecheck: LIVECHECK.stable,
  },
  'trinity@next': {
    name: 'Trinity (next)',
    conflicts: 'trinity',
    version: NEXT,
    livecheck: LIVECHECK.next,
  },
};

/** @param {{ cask: string, version: string, sha256: string }} release */
export function renderCask({ cask, version, sha256 }) {
  const spec = Object.hasOwn(CASKS, cask) ? CASKS[cask] : undefined;
  if (!spec) {
    throw new Error(
      `Unknown cask "${cask}"; expected trinity or trinity@next.`,
    );
  }
  if (!spec.version.test(version)) {
    throw new Error(`Version "${version}" does not fit cask ${cask}.`);
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('sha256 must be 64 lowercase hex characters.');
  }
  return `cask "${cask}" do
  version "${version}"
  sha256 "${sha256}"

  url "${REPO}/releases/download/v#{version}/Trinity-#{version}-arm64-mac.zip"
  name "${spec.name}"
  desc "End-to-end encrypted Matrix client"
  homepage "${REPO}"

  livecheck do
${spec.livecheck}  end

  conflicts_with cask: "${spec.conflicts}"
  depends_on arch: :arm64
  depends_on macos: ">= :ventura"

  app "Trinity.app"

  zap trash: [
    "~/Library/Application Support/trinity-desktop",
    "~/Library/Preferences/eu.qwky.trinity.plist",
    "~/Library/Saved Application State/eu.qwky.trinity.savedState",
  ]
end
`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      cask: { type: 'string' },
      version: { type: 'string' },
      sha256: { type: 'string' },
    },
  });
  process.stdout.write(renderCask(values));
}
