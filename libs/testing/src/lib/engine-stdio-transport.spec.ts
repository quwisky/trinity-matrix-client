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
  startTesthostAccount,
  testhostBinaryAvailable,
} from './engine-stdio-transport';

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

  it('dispose ends the host with exit code 0 while a stream is open', async () => {
    transport = StdioTransport.start();
    const ended = failure(transport.open('testhost.ticks', [5]));
    await lastValueFrom(transport.open('testhost.echo', [null]));

    await transport.dispose();

    expect(transport.child.exitCode).toBe(0);
    expect(await ended).toMatchObject(exited);
  });

  it('RUST_LOG=debug output never reaches the frame stream', async () => {
    transport = StdioTransport.start({
      env: { ...process.env, RUST_LOG: 'debug' },
    });
    const stdout = capture(transport.child.stdout);
    const stderr = capture(transport.child.stderr);
    const start = {
      homeserverUrl: 'http://127.0.0.1:1',
      userId: '@a:b',
      deviceId: 'DEVICE',
      accessToken: 'token',
    };

    const result = await lastValueFrom(
      transport.open('testhost.startAccount', [start]),
    );
    await transport.dispose();

    expect(result).toMatchObject({ ok: false, failure: { kind: 'network' } });
    expect(stderr()).toContain('DEBUG');
    const lines = stdout().trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ id: 1 });
    }
  });

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
    // Answers every open with the line in $FRAME and exits on EOF.
    writeFileSync(
      host,
      String.raw`#!/bin/sh
while IFS= read -r line; do
  case "$line" in *'"t":"open"'*) printf '%s\n' "$FRAME" ;; esac
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

  it('signs an account in, and fails when the host does not start it', async () => {
    vi.stubEnv('TRINITY_ENGINE_TESTHOST', host);
    const user = { userId: '@a:hs', deviceId: 'D', accessToken: 't' };
    vi.stubEnv('FRAME', '{"k":"next","id":1,"v":{"ok":true,"value":null}}');
    transport = await startTesthostAccount('https://hs', user);

    vi.stubEnv('FRAME', '{"k":"next","id":1,"v":{"ok":false,"failure":{}}}');
    await expect(startTesthostAccount('https://hs', user)).rejects.toThrow(
      'testhost.startAccount failed: {"ok":false,"failure":{}}',
    );
  });

  it('settles dispose when the host fails to start', async () => {
    transport = StdioTransport.start({ binary: join(directory, 'missing') });

    await expect(transport.dispose()).resolves.toBeUndefined();
    expect(await failure(transport.open('any.method', []))).toMatchObject(
      exited,
    );
  });
});
