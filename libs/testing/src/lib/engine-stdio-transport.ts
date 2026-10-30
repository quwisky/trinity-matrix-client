import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { Observable, firstValueFrom, type Subscriber } from 'rxjs';
import {
  EngineFaultError,
  type EngineTransport,
  type Fault,
  type Frame,
  type Inbound,
} from '@trinity/util/matrix';

const DISPOSE_GRACE_MS = 5000;

/** Whether `TRINITY_ENGINE_TESTHOST` names a built test host binary. */
export function testhostBinaryAvailable(): boolean {
  const binary = process.env['TRINITY_ENGINE_TESTHOST'];
  return binary !== undefined && existsSync(binary);
}

/** Drives the Rust test host over stdio, one JSON frame per line. Node only, for tests. */
export class StdioTransport implements EngineTransport {
  private readonly streams = new Map<number, Subscriber<unknown>>();
  private nextId = 1;
  /** Set once the host is gone or its output is unreadable; every later stream fails with it. */
  private dead: EngineFaultError | undefined;

  private constructor(readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout })
      .on('line', (line) => this.receive(line))
      .on('close', () =>
        this.fail('testhost-exited', 'the test host closed its output'),
      );
    child.on('error', (error) => this.fail('testhost-exited', error.message));
    child.stdin.on('error', (error) =>
      this.fail('testhost-exited', error.message),
    );
    child.stderr.pipe(process.stderr);
    this.write({ t: 'attach' });
  }

  static start(
    options: { binary?: string; env?: NodeJS.ProcessEnv } = {},
  ): StdioTransport {
    const binary = options.binary ?? process.env['TRINITY_ENGINE_TESTHOST'];
    if (!binary) {
      throw new Error('Set TRINITY_ENGINE_TESTHOST to the test host binary');
    }
    return new StdioTransport(spawn(binary, [], { env: options.env }));
  }

  open(method: string, args: readonly unknown[]): Observable<unknown> {
    return new Observable((subscriber) => {
      if (this.dead) {
        subscriber.error(this.dead);
        return;
      }
      const id = this.nextId++;
      this.write({ t: 'open', id, method, args: [...args] });
      this.streams.set(id, subscriber);
      return () => {
        if (this.streams.delete(id)) {
          this.write({ t: 'close', id });
        }
      };
    });
  }

  /** Ends the host's input and waits until it has exited. */
  async dispose(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    // Not events.once: it rejects when the child emitted `error` first, as a failed spawn does.
    const closed = new Promise((resolve) => this.child.once('close', resolve));
    this.child.stdin.end();
    const kill = setTimeout(() => this.child.kill('SIGKILL'), DISPOSE_GRACE_MS);
    await closed;
    clearTimeout(kill);
  }

  private write(message: Inbound): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    const frame = parseFrame(line);
    if (!frame) {
      this.fail(
        'bad-frame',
        'the test host wrote a line to stdout that is not a frame',
        'protocol',
      );
      return;
    }
    const subscriber = this.streams.get(frame.id);
    if (!subscriber) {
      return;
    }
    if (frame.k === 'next') {
      subscriber.next(frame.v);
      return;
    }
    // Forgotten first, so the teardown that completing runs sends no close.
    this.streams.delete(frame.id);
    if (frame.k === 'complete') {
      subscriber.complete();
    } else {
      subscriber.error(new EngineFaultError(frame.e));
    }
  }

  private fail(
    code: string,
    diagnostic: string,
    kind: Fault['kind'] = 'internal',
  ): void {
    this.dead ??= new EngineFaultError({ kind, code, diagnostic });
    const open = [...this.streams.values()];
    this.streams.clear();
    for (const subscriber of open) {
      subscriber.error(this.dead);
    }
  }
}

/**
 * Starts the test host with `user` signed in on `baseUrl`, for a Rust contract spec to dispose.
 * Node only, for tests.
 */
export async function startTesthostAccount(
  baseUrl: string,
  user: { userId: string; deviceId: string; accessToken: string },
): Promise<StdioTransport> {
  const transport = StdioTransport.start();
  try {
    const started = await firstValueFrom(
      transport.open('testhost.startAccount', [
        {
          homeserverUrl: baseUrl,
          userId: user.userId,
          deviceId: user.deviceId,
          accessToken: user.accessToken,
        },
      ]),
    );
    if (!isDeepStrictEqual(started, { ok: true, value: null })) {
      throw new Error(
        `testhost.startAccount failed: ${JSON.stringify(started)}`,
      );
    }
    return transport;
  } catch (error) {
    await transport.dispose();
    throw error;
  }
}

/** `line` as a frame, or `undefined` when it is not one. */
function parseFrame(line: string): Frame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'number'
  ) {
    return undefined;
  }
  const frame = value as { k?: unknown; v?: unknown; e?: unknown };
  const valid =
    (frame.k === 'next' && 'v' in frame) ||
    frame.k === 'complete' ||
    (frame.k === 'error' && typeof frame.e === 'object' && frame.e !== null);
  return valid ? (value as Frame) : undefined;
}
