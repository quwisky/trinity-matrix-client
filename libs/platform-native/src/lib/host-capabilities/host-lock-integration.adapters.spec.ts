import { TestBed } from '@angular/core/testing';
import {
  HOST_OPERATIONS,
  HostCapabilitiesService,
} from '@trinity/runtime/host';
import { desktopBridgeFixture } from '@trinity/testing';
import { firstValueFrom, of, take, toArray } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElectronLockIntegrationAdapter } from './host-lock-integration.adapters';

describe('ElectronLockIntegrationAdapter', () => {
  afterEach(() => {
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    TestBed.resetTestingModule();
  });

  function setup(granted: boolean) {
    let emit: (request: 'menu' | 'system-locked' | 'suspended') => void = () =>
      undefined;
    const lockIntegration = {
      setState: vi.fn(),
      coverPainted: vi.fn(),
      subscribeRequests: vi.fn(
        (
          callback: (request: 'menu' | 'system-locked' | 'suspended') => void,
        ) => {
          emit = callback;
          return () => undefined;
        },
      ),
    };
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
      desktopBridgeFixture({ capabilities: { lockIntegration } });
    TestBed.configureTestingModule({
      providers: [
        ElectronLockIntegrationAdapter,
        {
          provide: HostCapabilitiesService,
          useValue: {
            manifest: () =>
              of({
                protocolVersion: 1,
                operations: Object.fromEntries(
                  HOST_OPERATIONS.map((operation) => [
                    operation,
                    operation === 'lock-integration' && granted
                      ? { kind: 'supported' }
                      : { kind: 'unavailable', reason: 'not-supported' },
                  ]),
                ),
              }),
          },
        },
      ],
    });
    return {
      adapter: TestBed.inject(ElectronLockIntegrationAdapter),
      lockIntegration,
      emit: (request: 'menu' | 'system-locked' | 'suspended') => emit(request),
    };
  }

  it('sends state and the painted signal through the granted bridge', async () => {
    const { adapter, lockIntegration } = setup(true);
    await expect(
      firstValueFrom(
        adapter.setState({ enabled: true, locked: true, accelerator: null }),
      ),
    ).resolves.toEqual({ kind: 'completed' });
    await firstValueFrom(adapter.coverPainted());
    expect(lockIntegration.setState).toHaveBeenCalledWith({
      enabled: true,
      locked: true,
      accelerator: null,
    });
    expect(lockIntegration.coverPainted).toHaveBeenCalledOnce();
  });

  it('emits requests from the shell', async () => {
    const { adapter, emit } = setup(true);
    const requests = firstValueFrom(adapter.requests.pipe(take(2), toArray()));
    await Promise.resolve();
    emit('suspended');
    emit('menu');
    await expect(requests).resolves.toEqual(['suspended', 'menu']);
  });

  it('does nothing when the operation is not granted', async () => {
    const { adapter, lockIntegration } = setup(false);
    await expect(
      firstValueFrom(
        adapter.setState({ enabled: true, locked: false, accelerator: null }),
      ),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'not-supported' });
    expect(lockIntegration.setState).not.toHaveBeenCalled();
  });
});
