import { TestBed } from '@angular/core/testing';
import {
  HOST_CAPABILITY_NEGOTIATOR,
  HOST_OPERATIONS,
  HostCapabilitiesService,
  unavailableHostManifest,
  type HostCapabilityManifest,
} from '@trinity/runtime/host';
import { desktopBridgeFixture } from '@trinity/testing';
import { firstValueFrom, of, take, toArray, type Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElectronLockIntegrationAdapter } from './host-lock-integration.adapters';

describe('ElectronLockIntegrationAdapter', () => {
  afterEach(() => {
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    TestBed.resetTestingModule();
  });

  function manifest(granted: boolean): HostCapabilityManifest {
    return {
      protocolVersion: 1,
      operations: Object.fromEntries(
        HOST_OPERATIONS.map((operation) => [
          operation,
          operation === 'lock-integration' && granted
            ? { kind: 'supported' }
            : { kind: 'unavailable', reason: 'not-supported' },
        ]),
      ) as HostCapabilityManifest['operations'],
    };
  }

  function setup(
    granted: boolean,
    negotiate: () => Observable<HostCapabilityManifest> = () =>
      of(manifest(granted)),
  ) {
    const unsubscribe = vi.fn();
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
          return unsubscribe;
        },
      ),
    };
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
      desktopBridgeFixture({ capabilities: { lockIntegration } });
    TestBed.configureTestingModule({
      providers: [
        ElectronLockIntegrationAdapter,
        {
          provide: HOST_CAPABILITY_NEGOTIATOR,
          useValue: { manifest: negotiate },
        },
      ],
    });
    return {
      adapter: TestBed.inject(ElectronLockIntegrationAdapter),
      lockIntegration,
      unsubscribe,
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

  it('unsubscribes from the shell once the last subscriber leaves', async () => {
    const { adapter, lockIntegration, unsubscribe } = setup(true);
    const first = adapter.requests.subscribe();
    const second = adapter.requests.subscribe();
    await vi.waitFor(() =>
      expect(lockIntegration.subscribeRequests).toHaveBeenCalledOnce(),
    );
    first.unsubscribe();
    expect(unsubscribe).not.toHaveBeenCalled();
    second.unsubscribe();
    expect(unsubscribe).toHaveBeenCalledOnce();
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

  function failingOnce() {
    return vi
      .fn<() => Observable<HostCapabilityManifest>>()
      .mockReturnValueOnce(of(unavailableHostManifest('host-rejected')))
      .mockReturnValue(of(manifest(true)));
  }

  it('delivers requests once a failed negotiation is retried', async () => {
    const negotiate = failingOnce();
    const { adapter, lockIntegration, emit } = setup(true, negotiate);
    const seen: string[] = [];
    const subscription = adapter.requests.subscribe((request) =>
      seen.push(request),
    );
    expect(lockIntegration.subscribeRequests).not.toHaveBeenCalled();

    // Startup's Retry.
    await firstValueFrom(TestBed.inject(HostCapabilitiesService).manifest());
    emit('menu');

    expect(seen).toEqual(['menu']);
    expect(lockIntegration.subscribeRequests).toHaveBeenCalledOnce();
    expect(negotiate).toHaveBeenCalledTimes(2);
    subscription.unsubscribe();
  });

  it('sends the state once a failed negotiation is retried', async () => {
    const negotiate = failingOnce();
    const { adapter, lockIntegration } = setup(true, negotiate);
    const state = { enabled: true, locked: false, accelerator: null };
    adapter.setState(state).subscribe();
    expect(lockIntegration.setState).not.toHaveBeenCalled();

    // Startup's Retry.
    await firstValueFrom(TestBed.inject(HostCapabilitiesService).manifest());

    expect(lockIntegration.setState).toHaveBeenCalledExactlyOnceWith(state);
    expect(negotiate).toHaveBeenCalledTimes(2);
  });
});
