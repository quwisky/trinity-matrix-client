import { describe, expect, it } from 'vitest';
import { offsetPorts, resolvePortOffset } from './constants.mjs';
import {
  optionalReady,
  resolveHomeserverRuntime,
  unavailableFeatures,
} from './kind.mts';

describe('homeserver features', () => {
  it('lists the features a session lacks, in declaration order', () => {
    expect(
      unavailableFeatures({
        remote: false,
        sso: true,
        mail: true,
        identity: false,
      }),
    ).toEqual(['remote', 'identity']);
    expect(
      unavailableFeatures({
        remote: true,
        sso: true,
        mail: true,
        identity: true,
      }),
    ).toEqual([]);
  });

  it('makes an optional service unavailable when its wait fails', async () => {
    const logged: string[] = [];
    const log = (message: string): void => void logged.push(message);
    await expect(
      optionalReady(async () => undefined, { name: 'Sydent', log }),
    ).resolves.toBe(true);
    const identity = await optionalReady(
      async () => {
        throw new Error('timed out waiting for sydent (https)');
      },
      { name: 'Sydent', log },
    );
    expect(identity).toBe(false);
    expect(logged).toEqual([
      'Sydent did not become ready, so it is unavailable',
    ]);
    expect(
      unavailableFeatures({ remote: true, sso: true, mail: true, identity }),
    ).toEqual(['identity']);
  });

  it('still fails an aborted start', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      optionalReady(
        async () => {
          throw new Error('aborted');
        },
        { name: 'Sydent', log: () => undefined, signal: controller.signal },
      ),
    ).rejects.toThrow('aborted');
  });
});

describe('TRINITY_E2E_PORT_OFFSET', () => {
  it('accepts a non-negative integer and defaults to 0', () => {
    expect(resolvePortOffset({})).toBe(0);
    expect(resolvePortOffset({ TRINITY_E2E_PORT_OFFSET: '' })).toBe(0);
    expect(resolvePortOffset({ TRINITY_E2E_PORT_OFFSET: '100' })).toBe(100);
    expect(resolvePortOffset({ TRINITY_E2E_PORT_OFFSET: '6900' })).toBe(6900);
    for (const value of [
      '-1',
      '1.5',
      'abc',
      ' 100',
      '0x10',
      '4',
      '150',
      '7000',
    ]) {
      expect(() =>
        resolvePortOffset({ TRINITY_E2E_PORT_OFFSET: value }),
      ).toThrow(
        /Invalid TRINITY_E2E_PORT_OFFSET .*multiple of 100 from 0 to 6900/,
      );
    }
  });

  it('shifts only the stack ports, and nothing at 0', () => {
    const text = 'issuer: http://localhost:5556/dex at 10:1234 and :8448';
    expect(offsetPorts(text, 0)).toBe(text);
    expect(offsetPorts(text, 100)).toBe(
      'issuer: http://localhost:5656/dex at 10:1234 and :8548',
    );
  });

  it('needs the native runtime', () => {
    const offset = { TRINITY_E2E_PORT_OFFSET: '100' };
    expect(() => resolveHomeserverRuntime(offset)).toThrow(
      /TRINITY_E2E_PORT_OFFSET needs TRINITY_E2E_HOMESERVER_RUNTIME=native/,
    );
    expect(
      resolveHomeserverRuntime({
        ...offset,
        TRINITY_E2E_HOMESERVER: 'synapse',
        TRINITY_E2E_HOMESERVER_RUNTIME: 'native',
      }),
    ).toBe('native');
  });
});
