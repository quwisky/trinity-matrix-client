import { session } from 'electron';

/**
 * What main found when it asked an origin itself: a Matrix homeserver, a host that only
 * serves a server name's `.well-known/matrix/client` (delegation), a host that answered
 * as neither, or one that did not answer at all.
 */
export type ProbeResult =
  'homeserver' | 'well-known' | 'refused' | 'unreachable';

const TIMEOUT_MS = 10_000;
// A versions answer with every unstable feature listed is a few KiB.
const MAX_BODY_BYTES = 65_536;

const UNREACHABLE = Symbol('unreachable');

/** The JSON at `url`, `null` when the host answered anything else, or UNREACHABLE. */
async function fetchJson(url: string): Promise<unknown> {
  try {
    // A session of its own, in memory: it holds no cookies or cached credentials, and the
    // app session's interceptor (which waits on this probe) never sees the request.
    const response = await session
      .fromPartition('trinity-cors-probe')
      .fetch(url, {
        credentials: 'omit',
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    if (response.status !== 200 || response.redirected || !response.body) {
      return null;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      return null;
    }
  } catch (error) {
    // Electron fails a manual redirect ("Redirect was cancelled") instead of returning
    // the 3xx, and the host did answer. Should the wording change, a redirecting host
    // reads as unreachable again: still never confirmed, only asked more often.
    return error instanceof Error && /redirect/i.test(error.message)
      ? null
      : UNREACHABLE;
  }
}

// "Values will take the form `vX.Y` or `rX.Y.Z` in historical cases" (client-server API).
const SPEC_VERSION = /^(v\d+\.\d+|r\d+\.\d+\.\d+)$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Ask `origin` whether it is a Matrix server, from the main process. The renderer's word
 * is not evidence: it is the party the CORS allowlist bounds (see cors.ts).
 */
export async function probeMatrixOrigin(origin: string): Promise<ProbeResult> {
  if (!origin.startsWith('https://')) {
    return 'refused';
  }
  const versionsAnswer = fetchJson(`${origin}/_matrix/client/versions`);
  const wellKnownAnswer = fetchJson(`${origin}/.well-known/matrix/client`);
  // Both are asked at once, but a homeserver does not wait for its well-known.
  const versions = await versionsAnswer;
  if (
    isRecord(versions) &&
    Array.isArray(versions['versions']) &&
    versions['versions'].some(
      (version) => typeof version === 'string' && SPEC_VERSION.test(version),
    )
  ) {
    return 'homeserver';
  }
  const wellKnown = await wellKnownAnswer;
  const homeserver = isRecord(wellKnown) ? wellKnown['m.homeserver'] : null;
  if (isRecord(homeserver) && typeof homeserver['base_url'] === 'string') {
    return 'well-known';
  }
  return versions === UNREACHABLE || wellKnown === UNREACHABLE
    ? 'unreachable'
    : 'refused';
}
