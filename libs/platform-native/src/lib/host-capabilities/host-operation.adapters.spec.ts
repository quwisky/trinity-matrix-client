import { TestBed } from '@angular/core/testing';
import { SwUpdate } from '@angular/service-worker';
import {
  HostCapabilitiesService,
  unavailableHostManifest,
} from '@trinity/runtime/host';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileSaveService } from '../host-media/file-save.service';
import { WebHostCapabilityAdapter } from './host-capability.adapters';
import {
  CapacitorHostOperationAdapter,
  DocumentHostLifecycleAdapter,
  HostFileExportAdapter,
  ServiceWorkerHostUpdatesAdapter,
} from './host-operation.adapters';

const app = vi.hoisted(() => ({
  addListener: vi.fn(),
  getLaunchUrl: vi.fn(),
  minimizeApp: vi.fn(),
}));

const cap = vi.hoisted(() => ({ native: true, platform: 'android' }));

vi.mock('@capacitor/app', () => ({ App: app }));
vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => ({})),
  Capacitor: {
    isNativePlatform: () => cap.native,
    getPlatform: () => cap.platform,
  },
}));

describe('CapacitorHostOperationAdapter event streams', () => {
  beforeEach(() => {
    app.addListener.mockReset();
    app.getLaunchUrl.mockReset();
    app.minimizeApp.mockReset();
    app.getLaunchUrl.mockResolvedValue(null);
    cap.native = true;
    cap.platform = 'android';
  });

  it('routes rejected deep-link listener setup through the Observable error channel', async () => {
    const failure = new Error('listener setup failed');
    app.addListener.mockRejectedValue(failure);

    await expect(
      firstValueFrom(new CapacitorHostOperationAdapter().received),
    ).rejects.toBe(failure);
  });

  it('routes rejected launch URL reads through the Observable error channel', async () => {
    const failure = new Error('launch URL failed');
    app.addListener.mockImplementation(() => new Promise(() => undefined));
    app.getLaunchUrl.mockRejectedValue(failure);

    await expect(
      firstValueFrom(new CapacitorHostOperationAdapter().received),
    ).rejects.toBe(failure);
  });

  it('removes a Back listener that resolves after teardown', async () => {
    let resolveListener!: (value: { remove: () => Promise<void> }) => void;
    const remove = vi.fn(() => Promise.resolve());
    app.addListener.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveListener = resolve;
        }),
    );
    const subscription =
      new CapacitorHostOperationAdapter().intents.subscribe();

    subscription.unsubscribe();
    resolveListener({ remove });
    await Promise.resolve();
    await Promise.resolve();

    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('reports Back and backgrounding unavailable on iOS', async () => {
    cap.platform = 'ios';
    const adapter = new CapacitorHostOperationAdapter();
    const completed = vi.fn();

    adapter.intents.subscribe({ complete: completed });

    await expect(firstValueFrom(adapter.backSupport())).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    await expect(firstValueFrom(adapter.background())).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    expect(completed).toHaveBeenCalledTimes(1);
    expect(app.addListener).not.toHaveBeenCalled();
    expect(app.minimizeApp).not.toHaveBeenCalled();
  });
});

describe('file, lifecycle and update host operation contracts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  function manifest() {
    const value = unavailableHostManifest('not-implemented');
    return {
      ...value,
      operations: {
        ...value.operations,
        'file-export': { kind: 'supported' as const },
        lifecycle: { kind: 'supported' as const },
      },
    };
  }

  it('keeps file export cold, finite and normalized through the selected host adapter', async () => {
    const save = vi.fn(() => of(undefined));
    TestBed.configureTestingModule({
      providers: [
        HostFileExportAdapter,
        MockProvider(HostCapabilitiesService, {
          manifest: () => of(manifest()),
        }),
        MockProvider(FileSaveService, { save }),
      ],
    });
    const adapter = TestBed.inject(HostFileExportAdapter);
    const request = { bytes: new Blob(['safe']), filename: 'safe.txt' };
    const command = adapter.save(request);

    expect(save).not.toHaveBeenCalled();
    await expect(firstValueFrom(command)).resolves.toEqual({
      kind: 'completed',
    });
    expect(save).toHaveBeenCalledExactlyOnceWith(
      request.bytes,
      request.filename,
    );
  });

  it('contains file-host failures behind a secret-safe rejection', async () => {
    TestBed.configureTestingModule({
      providers: [
        HostFileExportAdapter,
        MockProvider(HostCapabilitiesService, {
          manifest: () => of(manifest()),
        }),
        MockProvider(FileSaveService, {
          save: () => throwError(() => new Error('secret file payload')),
        }),
      ],
    });

    await expect(
      firstValueFrom(
        TestBed.inject(HostFileExportAdapter).save({
          bytes: new Blob(['secret']),
          filename: 'secret.txt',
        }),
      ),
    ).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'file-export-failed' },
    });
  });

  it('projects document foregrounding through the lifecycle contract', async () => {
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('visible');
    const adapter = TestBed.inject(DocumentHostLifecycleAdapter);
    const active = firstValueFrom(adapter.events);

    document.dispatchEvent(new Event('visibilitychange'));

    await expect(active).resolves.toEqual({ kind: 'active' });
    visibility.mockReturnValue('hidden');
    const background = firstValueFrom(adapter.events);
    document.dispatchEvent(new Event('visibilitychange'));
    await expect(background).resolves.toEqual({ kind: 'background' });
  });

  it('returns explicit update unavailability when this host has no service worker', async () => {
    const checkForUpdate = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        ServiceWorkerHostUpdatesAdapter,
        MockProvider(SwUpdate, { isEnabled: false, checkForUpdate }),
      ],
    });
    const command = TestBed.inject(ServiceWorkerHostUpdatesAdapter).check();

    expect(checkForUpdate).not.toHaveBeenCalled();
    await expect(firstValueFrom(command)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    expect(checkForUpdate).not.toHaveBeenCalled();
  });

  it('runs a supported update check lazily through the shared operation', async () => {
    const checkForUpdate = vi.fn().mockResolvedValue(true);
    TestBed.configureTestingModule({
      providers: [
        ServiceWorkerHostUpdatesAdapter,
        MockProvider(SwUpdate, { isEnabled: true, checkForUpdate }),
      ],
    });
    const command = TestBed.inject(ServiceWorkerHostUpdatesAdapter).check();

    expect(checkForUpdate).not.toHaveBeenCalled();
    await expect(firstValueFrom(command)).resolves.toEqual({
      kind: 'completed',
    });
    expect(checkForUpdate).toHaveBeenCalledOnce();
  });

  it('keeps Web update discovery aligned with the shared operation', async () => {
    const checkForUpdate = vi.fn().mockResolvedValue(true);
    TestBed.configureTestingModule({
      providers: [
        WebHostCapabilityAdapter,
        ServiceWorkerHostUpdatesAdapter,
        MockProvider(SwUpdate, { isEnabled: true, checkForUpdate }),
      ],
    });
    const manifest = await firstValueFrom(
      TestBed.inject(WebHostCapabilityAdapter).manifest(),
    );
    const command = TestBed.inject(ServiceWorkerHostUpdatesAdapter).check();

    expect(manifest.operations.updates).toEqual({ kind: 'supported' });
    expect(checkForUpdate).not.toHaveBeenCalled();
    await expect(firstValueFrom(command)).resolves.toEqual({
      kind: 'completed',
    });
    expect(checkForUpdate).toHaveBeenCalledOnce();
  });
});
