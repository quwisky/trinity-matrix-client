import { app, dialog, net, Notification, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * "A new version is available" notices for the desktop app.
 *
 * There is no auto-updater (that needs signed Windows builds first). Instead the app
 * asks GitHub Releases for the newest published release on its own line — stable builds
 * only see stable releases; `-next` builds also see newer prereleases — and shows one OS
 * notification per new version, which opens that release's page. The Help menu runs the
 * same check on demand. Off in unpackaged builds and when TRINITY_DISABLE_UPDATE_CHECK=1.
 */

const RELEASES_URL =
  'https://api.github.com/repos/quwisky/trinity-matrix-client/releases?per_page=30';
const RELEASE_PAGE =
  /^https:\/\/github\.com\/quwisky\/trinity-matrix-client\/releases\/tag\/[\w.-]+$/;
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-next\.(\d+))?$/;
const STATE_FILE = 'update-check.json';
const FIRST_CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** The `-next.N` number, or `null` for a stable version. */
  next: number | null;
}

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}

export interface AvailableRelease {
  version: string;
  url: string;
}

export function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    next: match[4] === undefined ? null : Number(match[4]),
  };
}

/** Semver order for the two shapes Trinity ships; a prerelease precedes its stable version. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.next === b.next) return 0;
  if (a.next === null) return 1;
  if (b.next === null) return -1;
  return a.next - b.next;
}

/** The newest published release on the installed line that is newer than `current`. */
export function newestRelease(
  current: string,
  releases: readonly GitHubRelease[],
): AvailableRelease | null {
  const installed = parseVersion(current);
  if (!installed) return null;
  let best: { parsed: ParsedVersion; release: AvailableRelease } | null = null;
  for (const candidate of releases) {
    if (candidate.draft || !RELEASE_PAGE.test(candidate.html_url)) continue;
    const parsed = parseVersion(candidate.tag_name);
    if (!parsed) continue;
    if (parsed.next !== null && installed.next === null) continue;
    if (compareVersions(parsed, installed) <= 0) continue;
    if (best && compareVersions(parsed, best.parsed) <= 0) continue;
    best = {
      parsed,
      release: {
        version: candidate.tag_name.replace(/^v/, ''),
        url: candidate.html_url,
      },
    };
  }
  return best?.release ?? null;
}

export function updateChecksEnabled(): boolean {
  return app.isPackaged && process.env.TRINITY_DISABLE_UPDATE_CHECK !== '1';
}

async function fetchReleases(): Promise<GitHubRelease[]> {
  const response = await net.fetch(RELEASES_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `Trinity/${app.getVersion()}`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`GitHub Releases answered ${response.status}`);
  const body: unknown = await response.json();
  if (!Array.isArray(body))
    throw new Error('GitHub Releases returned an unexpected shape');
  return body.filter(
    (entry): entry is GitHubRelease =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof entry.tag_name === 'string' &&
      typeof entry.html_url === 'string' &&
      typeof entry.draft === 'boolean' &&
      typeof entry.prerelease === 'boolean',
  );
}

function statePath(): string {
  return path.join(app.getPath('userData'), STATE_FILE);
}

function lastNotifiedVersion(): string | null {
  try {
    const state: unknown = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return typeof state === 'object' &&
      state !== null &&
      'lastNotified' in state &&
      typeof state.lastNotified === 'string'
      ? state.lastNotified
      : null;
  } catch {
    return null;
  }
}

function rememberNotified(version: string): void {
  try {
    fs.writeFileSync(statePath(), JSON.stringify({ lastNotified: version }));
  } catch {
    // Losing this only means the same version may be announced once more.
  }
}

function announce(release: AvailableRelease): void {
  if (!Notification.isSupported()) return;
  new Notification({
    title: `Trinity ${release.version} is available`,
    body: 'Click to open the download page.',
  })
    .on('click', () => void shell.openExternal(release.url))
    .show();
}

/**
 * Check GitHub Releases once. Automatic checks announce each new version once and fail
 * silently; a manual check always announces and reports "up to date" or an error.
 */
export async function checkForUpdates({
  manual,
}: {
  manual: boolean;
}): Promise<void> {
  let release: AvailableRelease | null;
  try {
    release = newestRelease(app.getVersion(), await fetchReleases());
  } catch (error) {
    if (manual) {
      void dialog.showMessageBox({
        type: 'warning',
        message: "Couldn't check for updates.",
        detail: 'Check your connection and try again later.',
      });
    } else {
      console.warn('[update-check] check failed', String(error));
    }
    return;
  }
  if (!release) {
    if (manual) {
      void dialog.showMessageBox({
        type: 'info',
        message: `Trinity ${app.getVersion()} is the latest version.`,
      });
    }
    return;
  }
  if (!manual && lastNotifiedVersion() === release.version) return;
  rememberNotified(release.version);
  announce(release);
}

/** Start the background check: shortly after launch, then once a day. */
export function startUpdateChecks(): void {
  if (!updateChecksEnabled()) return;
  setTimeout(
    () => void checkForUpdates({ manual: false }),
    FIRST_CHECK_DELAY_MS,
  ).unref();
  setInterval(
    () => void checkForUpdates({ manual: false }),
    CHECK_INTERVAL_MS,
  ).unref();
}
