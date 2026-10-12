import { describe, expect, it } from 'vitest';
import type { DiagnosticEntry } from './diagnostic-entry.model';
import { buildDiagnosticBundle } from './diagnostic-bundle';
import { diagnosticLogFileName, type DiagnosticAccount } from './report-facts';
import type { DiagnosticSnapshot } from './store/diagnostic-log-store';

const T0 = Date.UTC(2026, 9, 11, 8);
const ALICE: DiagnosticAccount = {
  userId: '@alice:example.org',
  deviceId: 'QWERTYUIOP',
  homeserverUrl: 'https://matrix.example.org',
  software: { name: 'Synapse', version: '1.140.0' },
};
const ENTRIES: readonly DiagnosticEntry[] = [
  {
    ts: T0,
    level: 'info',
    source: 'app',
    logger: 'lifecycle',
    message:
      'app started: Trinity v0.4.0 · abc1234 on Web, Chrome 141 on macOS',
  },
  {
    ts: T0 + 1000,
    level: 'debug',
    source: 'sdk',
    logger: 'matrix',
    message:
      'FetchHttpApi: --> GET https://matrix.example.org/_matrix/client/v3/profile/%40bob%3Aother.net',
  },
  {
    ts: T0 + 2000,
    level: 'warn',
    source: 'console',
    logger: 'trinity',
    message: 'first line\nsecond line',
  },
];

function bundle(
  snapshot: Partial<DiagnosticSnapshot> = {},
  accounts = [ALICE],
) {
  return buildDiagnosticBundle({
    now: new Date(2026, 9, 11, 9, 30),
    build: {
      version: '0.4.0',
      commit: 'abc1234',
      builtAt: '',
      dependencies: { matrixJsSdk: '43.0.0', cryptoWasm: '18.9.0' },
    },
    platform: 'Web, Chrome 141 on macOS',
    accounts,
    snapshot: {
      entries: ENTRIES,
      dropped: false,
      storage: 'indexeddb',
      ...snapshot,
    },
  });
}

describe('diagnosticLogFileName', () => {
  it('names the file by the local date', () => {
    expect(diagnosticLogFileName(new Date(2026, 9, 1, 0, 30))).toBe(
      'trinity-2026-10-01.log',
    );
  });
});

describe('buildDiagnosticBundle', () => {
  it('writes a header with version, platform, library versions and redacted accounts', () => {
    const { text, filename } = bundle();

    expect(filename).toBe('trinity-2026-10-11.log');
    expect(text.split('\n').slice(0, 10)).toEqual([
      '# Trinity diagnostic log',
      '# Trinity v0.4.0 · abc1234',
      '# Platform: Web, Chrome 141 on macOS',
      '# matrix-js-sdk 43.0.0, matrix-sdk-crypto-wasm 18.9.0',
      '# Accounts signed in: 1',
      '# Account 1 (active): @me:server1 on https://server2, Synapse 1.140.0',
      '# Capture window: 2026-10-11T08:00:00.000Z to 2026-10-11T08:00:02.000Z (3 entries)',
      '# Storage: on this device (IndexedDB)',
      '# Dropped entries: none',
      '# Matrix IDs and server names are replaced with placeholders such as @user1:server1; tokens, keys and messages are never stored.',
    ]);
  });

  it('lists entries oldest first, one per line, redacted with the header', () => {
    const lines = bundle().text.trimEnd().split('\n').slice(10);

    expect(lines).toEqual([
      '2026-10-11T08:00:00.000Z INFO app/lifecycle app started: Trinity v0.4.0 · abc1234 on Web, Chrome 141 on macOS',
      '2026-10-11T08:00:01.000Z DEBUG sdk/matrix FetchHttpApi: --> GET https://server2/_matrix/client/v3/profile/%40user1%3Aserver3',
      '2026-10-11T08:00:02.000Z WARN console/trinity first line\\nsecond line',
    ]);
  });

  it('says when capture was in memory only and when entries were dropped', () => {
    const { text } = bundle({ storage: 'memory', dropped: true });

    expect(text).toContain(
      '# Storage: in memory only; this device would not let Trinity keep logs, so earlier sessions are missing',
    );
    expect(text).toContain(
      '# Dropped entries: older entries were removed to stay within 5 MB and 48 hours',
    );
  });

  it('says when there are no entries', () => {
    const result = bundle({ entries: [] }, []);

    expect(result.entryCount).toBe(0);
    expect(result.text).toContain('# Capture window: no entries');
    expect(result.text).toContain('# Accounts signed in: 0');
  });

  it('replaces a server name that appears before the identifier naming it, with no accounts', () => {
    // Signed out (the sign-in screen), nothing pre-registers the server of an earlier session.
    const result = bundle(
      {
        entries: [
          {
            ts: T0,
            level: 'warn',
            source: 'sdk',
            logger: 'matrix',
            message: 'Failed to reach other.net',
          },
          {
            ts: T0 + 1000,
            level: 'debug',
            source: 'sdk',
            logger: 'matrix',
            message: 'Invite from @bob:other.net',
          },
        ],
      },
      [],
    );

    expect(result.text).toContain('# Accounts signed in: 0');
    expect(result.text).toContain('WARN sdk/matrix Failed to reach server1');
    expect(result.text).toContain(
      'DEBUG sdk/matrix Invite from @user1:server1',
    );
    expect(result.text).not.toContain('other.net');
  });

  it('reports facts for the issue without any server name', () => {
    expect(bundle().facts).toEqual({
      version: 'Trinity v0.4.0 · abc1234',
      platform: 'Web, Chrome 141 on macOS',
      homeservers: ['Synapse 1.140.0'],
    });
  });
});
