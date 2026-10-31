import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  firstValueFrom,
  lastValueFrom,
  take,
  toArray,
  type Observable,
  type Subscription,
} from 'rxjs';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { assertPlainData, EngineFaultError } from '@trinity/util/matrix';
import {
  StdioTransport,
  testhostBinaryAvailable,
} from './engine-stdio-transport';
import { startRustAccount, startTesthostAccount } from './rust-account';

/** Everything `stream` emits from now on. */
function capture(stream: Readable): () => string {
  let text = '';
  stream.on('data', (chunk) => (text += String(chunk)));
  return () => text;
}

/** The error `stream` ends with. */
function failure(stream: Observable<unknown>): Promise<unknown> {
  return lastValueFrom(stream).then(
    () => new Error('the stream completed'),
    (error: unknown) => error,
  );
}

const exited = { fault: { code: 'testhost-exited' } };

describe.skipIf(!testhostBinaryAvailable())('StdioTransport', () => {
  let transport: StdioTransport | undefined;

  afterEach(async () => {
    await transport?.dispose();
  });

  it('echo round-trips plain data', async () => {
    transport = StdioTransport.start();

    const value = await firstValueFrom(
      transport.open('testhost.echo', [{ a: [1, null, 'x'] }]),
    );

    expect(value).toEqual({ a: [1, null, 'x'] });
    expect(() => assertPlainData(value)).not.toThrow();
  });

  it('unsubscribing a ticks stream stops it and a later echo still works', async () => {
    transport = StdioTransport.start();
    const stdout = capture(transport.child.stdout);

    const ticks = transport
      .open('testhost.ticks', [5])
      .pipe(take(3), toArray());
    expect(await firstValueFrom(ticks)).toEqual([0, 1, 2]);
    // Its complete is the last frame of the host's reply, sent after any tick already in flight.
    expect(
      await lastValueFrom(transport.open('testhost.echo', ['after'])),
    ).toBe('after');
    const seen = stdout().length;
    await sleep(50);

    expect(stdout().slice(seen)).toBe('');
  });

  it('an unknown method errors with EngineFaultError code unknown-method', async () => {
    transport = StdioTransport.start();

    const error = await failure(transport.open('nope.nothing', []));

    expect(error).toBeInstanceOf(EngineFaultError);
    expect(error).toMatchObject({
      fault: { kind: 'protocol', code: 'unknown-method' },
    });
  });

  it('killing the child errors every open stream', async () => {
    transport = StdioTransport.start();
    const errors = Promise.all([
      failure(transport.open('testhost.ticks', [5])),
      failure(transport.open('testhost.ticks', [5])),
    ]);
    // The host reads its input in order, so both ticks streams run once the echo replies.
    await lastValueFrom(transport.open('testhost.echo', [null]));

    transport.child.kill('SIGKILL');

    for (const error of await errors) {
      expect(error).toBeInstanceOf(EngineFaultError);
      expect(error).toMatchObject(exited);
    }
    expect(
      await failure(transport.open('testhost.echo', [null])),
    ).toMatchObject(exited);
  });

  it('dispose ends the host with exit code 0 and drops an open stream quietly', async () => {
    transport = StdioTransport.start();
    const events: string[] = [];
    transport.open('testhost.ticks', [5]).subscribe({
      error: () => events.push('error'),
      complete: () => events.push('complete'),
    });
    await lastValueFrom(transport.open('testhost.echo', [null]));

    await transport.dispose();
    await sleep(50);

    expect(transport.child.exitCode).toBe(0);
    expect(events).toEqual([]);
    expect(
      await failure(transport.open('testhost.echo', [null])),
    ).toMatchObject(exited);
  });

  it('RUST_LOG=debug output never reaches the frame stream', async () => {
    transport = StdioTransport.start({
      env: { ...process.env, RUST_LOG: 'debug' },
    });
    const stdout = capture(transport.child.stdout);
    const stderr = capture(transport.child.stderr);
    const session = {
      baseUrl: 'http://127.0.0.1:1',
      userId: '@a:b',
      deviceId: 'DEVICE',
      accessToken: 'token',
    };

    // It replies offline: a start does not wait for a sync.
    const result = await lastValueFrom(
      transport.open('session.restorePersisted', [session, 'activate']),
    );
    await transport.dispose();

    expect(result).toEqual({ ok: true, value: null });
    expect(stderr()).toContain('DEBUG');
    const lines = stdout().trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ id: 1 });
    }
  });

  it('carries nested Blobs to the host in order', async () => {
    transport = StdioTransport.start();

    const sizes = await firstValueFrom(
      transport.open('testhost.blobSizes', [
        [
          new Blob([Uint8Array.of(1, 2, 3)]),
          new Blob([]),
          new Blob([Uint8Array.of(4)]),
        ],
      ]),
    );

    expect(sizes).toEqual([
      { size: 3, sum: 6 },
      { size: 0, sum: 0 },
      { size: 1, sum: 4 },
    ]);
  });

  it('refuses a method without Blobs through openBytes', async () => {
    transport = StdioTransport.start();

    const error = await failure(
      transport.open('session.session', [new Blob([Uint8Array.of(1)])]),
    );

    expect(error).toMatchObject({
      fault: { kind: 'protocol', code: 'unknown-method' },
    });
  });

  it(
    'carries a Blob past the upload limit in one line',
    { timeout: 120_000 },
    async () => {
      transport = StdioTransport.start();
      const bytes = new Uint8Array(52_428_801);
      bytes[0] = 5;
      bytes[bytes.length - 1] = 7;

      const sizes = await firstValueFrom(
        transport.open('testhost.blobSizes', [[new Blob([bytes])]]),
      );

      expect(sizes).toEqual([{ size: 52_428_801, sum: 12 }]);
      expect(
        await lastValueFrom(transport.open('testhost.echo', ['after'])),
      ).toBe('after');
    },
  );

  it('unsubscribing after complete sends no close', async () => {
    transport = StdioTransport.start();
    const open = transport.open('testhost.echo', ['once']);
    const write = vi.spyOn(transport.child.stdin, 'write');

    let subscription: Subscription | undefined;
    await new Promise<void>((complete) => {
      subscription = open.subscribe({ complete });
    });
    subscription?.unsubscribe();

    const written = write.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(written).toEqual([
      { t: 'open', id: 1, method: 'testhost.echo', args: ['once'] },
    ]);
  });
});

describe('StdioTransport with a stand-in host', () => {
  let directory: string;
  let host: string;
  let transport: StdioTransport | undefined;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'trinity-testhost-'));
    host = join(directory, 'host.sh');
    // Answers a session.session open with $SNAPSHOT under its id, every other open with
    // $FRAME, and exits on EOF.
    writeFileSync(
      host,
      String.raw`#!/bin/sh
while IFS= read -r line; do
  id=${'$'}{line#*'"id":'}; id=${'$'}{id%%,*}
  case "$line" in
    *'"method":"session.session"'*) printf '%s\n' "$SNAPSHOT" | sed "s/\"id\":0/\"id\":$id/" ;;
    *'"t":"open"'*) printf '%s\n' "$FRAME" ;;
  esac
done
`,
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await transport?.dispose();
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    ['a line that is not JSON', 'not json'],
    ['a frame that is not an object', 'null'],
    ['a number', '5'],
    ['a frame without an id', '{"k":"complete"}'],
    ['a frame with a string id', '{"k":"complete","id":"1"}'],
    ['an error frame without e', '{"k":"error","id":1}'],
    ['a frame of an unknown kind', '{"k":"other","id":1}'],
  ])('fails every stream as bad-frame on %s', async (_name, frame) => {
    transport = StdioTransport.start({
      binary: host,
      env: { ...process.env, FRAME: frame },
    });
    const badFrame = { fault: { kind: 'protocol', code: 'bad-frame' } };

    const errors = await Promise.all([
      failure(transport.open('any.method', [])),
      failure(transport.open('any.method', [])),
    ]);

    for (const error of errors) {
      expect(error).toBeInstanceOf(EngineFaultError);
      expect(error).toMatchObject(badFrame);
    }
    expect(await failure(transport.open('any.method', []))).toMatchObject(
      badFrame,
    );
  });

  it('starts an account and waits for its sync, and fails when the host does not start it', async () => {
    vi.stubEnv('TRINITY_ENGINE_TESTHOST', host);
    const user = { userId: '@a:hs', deviceId: 'D', accessToken: 't' };
    vi.stubEnv('FRAME', '{"k":"next","id":1,"v":{"ok":true,"value":null}}');
    const account = { accountId: '@a:hs', serverSynced: true };
    const snapshot = (roomsPrepared: boolean) =>
      JSON.stringify({ accounts: [{ ...account, roomsPrepared }] });
    vi.stubEnv('SNAPSHOT', `{"k":"next","id":0,"v":${snapshot(true)}}`);
    transport = await startTesthostAccount('https://hs', user);

    vi.stubEnv('SNAPSHOT', `{"k":"next","id":0,"v":${snapshot(false)}}`);
    const unsynced = StdioTransport.start();
    await expect(
      startRustAccount(
        unsynced,
        { baseUrl: 'https://hs', ...user },
        { timeoutMs: 200 },
      ),
    ).rejects.toThrow('Timeout');
    await unsynced.dispose();

    vi.stubEnv('FRAME', '{"k":"next","id":1,"v":{"ok":false,"failure":{}}}');
    await expect(startTesthostAccount('https://hs', user)).rejects.toThrow(
      'session.restorePersisted failed: {"ok":false,"failure":{}}',
    );
  });

  describe('with Blob arguments', () => {
    function start() {
      transport = StdioTransport.start({
        binary: host,
        env: { ...process.env, FRAME: '{"k":"complete","id":99}' },
      });
      return vi.spyOn(transport.child.stdin, 'write');
    }

    /** The messages written so far. */
    const sent = (write: ReturnType<typeof start>) =>
      write.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown);

    /** A Blob-like that reads only once `release` is called. */
    function slowBlob() {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const blob = {
        arrayBuffer: async () => {
          await gate;
          return Uint8Array.of(1).buffer;
        },
      };
      return { blob, release };
    }

    it('writes one openBytes line for a call with Blobs', async () => {
      const write = start();

      const subscription = transport
        ?.open('any.method', [{ a: new Blob([Uint8Array.of(1, 2, 3)]) }])
        .subscribe();

      await vi.waitFor(() =>
        expect(sent(write)).toContainEqual({
          t: 'openBytes',
          id: 1,
          method: 'any.method',
          args: [{ a: { $blob: 0 } }],
          bytes: ['AQID'],
        }),
      );
      subscription?.unsubscribe();
    });

    it('writes a plain open for a call without Blobs', () => {
      const write = start();

      const subscription = transport
        ?.open('any.method', [{ a: 1 }])
        .subscribe();

      expect(sent(write)).toContainEqual({
        t: 'open',
        id: 1,
        method: 'any.method',
        args: [{ a: 1 }],
      });
      subscription?.unsubscribe();
    });

    it('writes no openBytes once unsubscribed during the read', async () => {
      const write = start();
      const { blob, release } = slowBlob();

      transport?.open('any.method', [blob]).subscribe().unsubscribe();
      release();
      await sleep(20);

      expect(
        sent(write).filter((m) => (m as { t: string }).t !== 'close'),
      ).toEqual([]);
    });

    it('writes nothing after a dispose during the read', async () => {
      const write = start();
      const { blob, release } = slowBlob();
      const subscription = transport?.open('any.method', [blob]).subscribe();
      const before = write.mock.calls.length;

      await transport?.dispose();
      release();
      await sleep(20);

      expect(write.mock.calls).toHaveLength(before);
      subscription?.unsubscribe();
    });

    it('fails only its own stream when a Blob cannot be read', async () => {
      start();
      const unreadable = { arrayBuffer: () => Promise.reject(new Error('x')) };
      const later = transport?.open('any.method', []).subscribe();

      const error = await failure(
        transport?.open('any.method', [unreadable]) as Observable<unknown>,
      );

      expect(error).toBeInstanceOf(EngineFaultError);
      expect(error).toMatchObject({ fault: { code: 'blob-unreadable' } });
      expect(later?.closed).toBe(false);
      expect(
        await failure(
          transport?.open('any.method', [unreadable]) as Observable<unknown>,
        ),
      ).toMatchObject({ fault: { code: 'blob-unreadable' } });
      later?.unsubscribe();
    });
  });

  it('settles dispose when the host fails to start', async () => {
    transport = StdioTransport.start({ binary: join(directory, 'missing') });

    await expect(transport.dispose()).resolves.toBeUndefined();
    expect(await failure(transport.open('any.method', []))).toMatchObject(
      exited,
    );
  });
});
