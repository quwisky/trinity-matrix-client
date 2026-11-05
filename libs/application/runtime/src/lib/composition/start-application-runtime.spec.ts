import { ErrorHandler, type ApplicationRef } from '@angular/core';
import {
  NativeKeyboardInsetAdapter,
  NativeStatusBarTapAdapter,
  SessionStorageService,
} from '@trinity/platform-native';
import { preloadCryptoWasm } from '@trinity/util/matrix';
import { Subject, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationRuntimeService } from '../application-runtime.service';
import { DiagnosticMarkersBinding } from './diagnostic-markers.binding';
import { SessionHandoverWorkflow } from './session-handover.workflow';
import { startApplicationRuntime } from './start-application-runtime';

vi.mock('@trinity/util/matrix', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trinity/util/matrix')>()),
  preloadCryptoWasm: vi.fn(),
}));

function fakeApplication({ storedAccount = true } = {}) {
  const runtime = new Subject<never>();
  const markers = new Subject<never>();
  const handover = new Subject<never>();
  const keyboardInset = new Subject<never>();
  const statusBarTap = new Subject<never>();
  const stop = vi.fn(() => of(undefined));
  const handleError = vi.fn();
  const destroyers: (() => void)[] = [];
  const services = new Map<unknown, unknown>([
    [ApplicationRuntimeService, { run: () => runtime, stop }],
    [ErrorHandler, { handleError }],
    [DiagnosticMarkersBinding, { run: () => markers }],
    [SessionHandoverWorkflow, { run: () => handover }],
    [NativeKeyboardInsetAdapter, { run: () => keyboardInset }],
    [NativeStatusBarTapAdapter, { run: () => statusBarTap }],
    [SessionStorageService, { hasAccounts: () => of(storedAccount) }],
  ]);
  const applicationRef = {
    injector: { get: (token: unknown) => services.get(token) },
    onDestroy: (destroy: () => void) => destroyers.push(destroy),
  } as unknown as ApplicationRef;
  return {
    applicationRef,
    runtime,
    markers,
    handover,
    keyboardInset,
    statusBarTap,
    stop,
    handleError,
    destroy: () => destroyers.forEach((destroy) => destroy()),
  };
}

describe('startApplicationRuntime', () => {
  beforeEach(() => {
    vi.mocked(preloadCryptoWasm).mockReset().mockReturnValue(of(undefined));
  });

  it('loads the crypto engine before the runtime restores any account', () => {
    const app = fakeApplication();
    let runtimeStartedFirst = false;
    vi.mocked(preloadCryptoWasm).mockImplementation(() => {
      runtimeStartedFirst = app.runtime.observed;
      return of(undefined);
    });

    startApplicationRuntime(app.applicationRef);

    expect(preloadCryptoWasm).toHaveBeenCalledOnce();
    expect(runtimeStartedFirst).toBe(false);
  });

  it('leaves the crypto engine to the sign-in when no account is stored', () => {
    const app = fakeApplication({ storedAccount: false });

    startApplicationRuntime(app.applicationRef);

    expect(preloadCryptoWasm).not.toHaveBeenCalled();
    expect(app.runtime.observed).toBe(true);
  });

  it('leaves a failed crypto engine load to the account that needs it', () => {
    vi.mocked(preloadCryptoWasm).mockReturnValue(
      throwError(() => new Error('wasm failed')),
    );
    const app = fakeApplication();

    startApplicationRuntime(app.applicationRef);

    expect(app.handleError).not.toHaveBeenCalled();
    expect(app.runtime.observed).toBe(true);
  });

  it('runs Application Runtime and the lifecycle markers for the life of the application', () => {
    const app = fakeApplication();

    startApplicationRuntime(app.applicationRef);

    expect(app.runtime.observed).toBe(true);
    expect(app.markers.observed).toBe(true);
    expect(app.handover.observed).toBe(true);
    expect(app.keyboardInset.observed).toBe(true);
    expect(app.statusBarTap.observed).toBe(true);

    app.destroy();

    expect(app.runtime.observed).toBe(false);
    expect(app.markers.observed).toBe(false);
    expect(app.handover.observed).toBe(false);
    expect(app.keyboardInset.observed).toBe(false);
    expect(app.statusBarTap.observed).toBe(false);
    expect(app.stop).toHaveBeenCalledOnce();
  });

  it('reports a marker failure to the error handler and keeps the runtime running', () => {
    const app = fakeApplication();
    startApplicationRuntime(app.applicationRef);
    const failure = new Error('markers failed');

    app.markers.error(failure);

    expect(app.handleError).toHaveBeenCalledWith(failure);
    expect(app.runtime.observed).toBe(true);
  });

  it('reports a handover failure to the error handler and keeps the runtime running', () => {
    const app = fakeApplication();
    startApplicationRuntime(app.applicationRef);
    const failure = new Error('handover failed');

    app.handover.error(failure);

    expect(app.handleError).toHaveBeenCalledWith(failure);
    expect(app.runtime.observed).toBe(true);
  });
});
