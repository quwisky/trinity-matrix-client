import {
  from,
  isObservable,
  of,
  type Observable,
  type ObservableInput,
} from 'rxjs';
import { describe, expect, it } from 'vitest';
import {
  EngineFaultError,
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
