/** Render the Homebrew cask for one published Trinity release (see the release guide). */
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
// The two lines are separate apps (Trinity and Trinity Next), so the casks install side
// by side and each zaps only its own data folder, caches, logs, preferences and saved state.
const CASKS = {
  trinity: {
    name: 'Trinity',
    app: 'Trinity',
    bundleId: 'dev.trinityproject.trinity',
    version: STABLE,
    livecheck: LIVECHECK.stable,
  },
  'trinity@next': {
    name: 'Trinity Next',
    app: 'Trinity Next',
    bundleId: 'dev.trinityproject.trinity.next',
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

  depends_on arch: :arm64
  depends_on macos: :ventura

  app "${spec.app}.app"

  zap trash: [
    "~/Library/Application Support/${spec.app}",
    "~/Library/Caches/${spec.bundleId}",
    "~/Library/Logs/${spec.app}",
    "~/Library/Preferences/${spec.bundleId}.plist",
    "~/Library/Saved Application State/${spec.bundleId}.savedState",
  ]
end
`;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      cask: { type: 'string' },
      version: { type: 'string' },
      sha256: { type: 'string' },
    },
  });
  process.stdout.write(renderCask(values));
}
