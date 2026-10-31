import {
  from,
  isObservable,
  of,
  type Observable,
  type ObservableInput,
} from 'rxjs';
import { Blob as NodeBlob } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  EngineFaultError,
  extractBlobs,
  proxyEngine,
  type EngineTransport,
} from './engine-transport';

interface SampleEngine {
  probe(accountId: string, limit: number): Observable<string>;
}

function recordingTransport() {
  const calls: { method: string; args: readonly unknown[] }[] = [];
  const reply = of('reply');
  const transport: EngineTransport = {
    open: (method, args) => {
      calls.push({ method, args });
      return reply;
    },
  };
  return { calls, reply, transport };
}

describe('proxyEngine', () => {
  it('routes a member call to engine.member with positional args', () => {
    const { calls, transport } = recordingTransport();

    proxyEngine<SampleEngine>('homeserver', transport).probe('@a:b', 3);

    expect(calls).toEqual([{ method: 'homeserver.probe', args: ['@a:b', 3] }]);
  });

  it("returns the transport's observable unchanged", () => {
    const { reply, transport } = recordingTransport();

    expect(
      proxyEngine<SampleEngine>('homeserver', transport).probe('@a:b', 3),
    ).toBe(reply);
  });

  it('is not mistaken for a promise when awaited', async () => {
    const { calls, transport } = recordingTransport();
    const engine = proxyEngine<SampleEngine>('homeserver', transport);

    await expect(Promise.resolve(engine)).resolves.toBe(engine);
    expect(calls).toEqual([]);
  });

  it('converts to a string and to JSON without opening a stream', () => {
    const { calls, transport } = recordingTransport();
    const engine = proxyEngine<SampleEngine>('homeserver', transport);

    expect(() => String(engine)).not.toThrow();
    expect(JSON.stringify(engine)).toBe('{}');
    expect(calls).toEqual([]);
  });

  it('is not taken for an interop observable or a stream by from()', () => {
    const { calls, transport } = recordingTransport();
    const engine = proxyEngine<SampleEngine>('homeserver', transport);

    expect(() => from(engine as unknown as ObservableInput<string>)).toThrow(
      TypeError,
    );
    expect(calls).toEqual([]);
  });

  it('is not taken for an observable by isObservable()', () => {
    const { calls, transport } = recordingTransport();
    const engine = proxyEngine<SampleEngine>('homeserver', transport);

    expect(isObservable(engine)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('hands a Blob argument to the transport unchanged, at any depth', () => {
    const { calls, transport } = recordingTransport();
    const blob = new Blob(['x']);

    proxyEngine<SampleEngine>('homeserver', transport).probe('a', {
      blob,
    } as never);

    expect((calls[0]?.args[1] as { blob: Blob }).blob).toBe(blob);
  });

  it('has no ngOnDestroy for an injector to call', () => {
    const { calls, transport } = recordingTransport();
    const engine = proxyEngine<SampleEngine>('homeserver', transport);

    expect(
      (engine as SampleEngine & { ngOnDestroy?: unknown }).ngOnDestroy,
    ).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('EngineFaultError', () => {
  it('keeps the diagnostic out of its message', () => {
    const fault = {
      kind: 'internal',
      code: 'panic',
      diagnostic: 'room.send panicked',
    } as const;

    const error = new EngineFaultError(fault);

    expect(error.message).toBe('engine fault: panic');
    expect(error.fault).toBe(fault);
  });
});

describe('extractBlobs', () => {
  const blobOf = (...bytes: number[]) => new Blob([Uint8Array.from(bytes)]);

  it('returns args without a Blob as they are', () => {
    const object = { a: [1, { b: 2 }] };
    const args = [object, [object], null, undefined, 0, ''];

    const { args: out, blobs } = extractBlobs(args);

    out.forEach((arg, at) => expect(arg).toBe(args[at]));
    expect(blobs).toEqual([]);
  });

  it('replaces Blobs at any depth, in order', () => {
    const a = blobOf(1);
    const b = blobOf(2);

    const { args, blobs } = extractBlobs([
      1,
      { file: a, thumbnail: { blob: b } },
    ]);

    expect(args).toEqual([
      1,
      { file: { $blob: 0 }, thumbnail: { blob: { $blob: 1 } } },
    ]);
    expect(blobs).toEqual([a, b]);
  });

  it('copies only what holds a Blob', () => {
    const sibling = { n: 1 };

    const { args } = extractBlobs([{ blob: blobOf(1), sibling }]);

    expect((args[0] as { sibling: unknown }).sibling).toBe(sibling);
  });

  it('keeps an own __proto__ key beside a Blob', () => {
    const data = JSON.parse('{"__proto__":{"x":1}}') as object;
    const top = JSON.parse('{"__proto__":{"y":2}}') as object;
    const arg = Object.assign(top, { blob: blobOf(1), data });

    const out = extractBlobs([arg]).args[0] as { data: object };

    expect(Object.keys(out)).toContain('__proto__');
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out.data)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(out.data)).toBe(Object.prototype);
  });

  it('leaves a plain $blob key alone', () => {
    const arg = { $blob: 7 };

    const { args, blobs } = extractBlobs([arg]);

    expect(args[0]).toBe(arg);
    expect(blobs).toEqual([]);
  });

  it("takes a File, jsdom's Blob and Node's Blob", () => {
    const blobs = [new File(['a'], 'a.txt'), blobOf(1), new NodeBlob(['n'])];

    const out = extractBlobs([blobs]);

    expect(out.args).toEqual([[{ $blob: 0 }, { $blob: 1 }, { $blob: 2 }]]);
    expect(out.blobs).toEqual(blobs);
  });
});
