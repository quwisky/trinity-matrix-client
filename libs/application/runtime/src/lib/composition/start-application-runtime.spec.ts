import { ErrorHandler, type ApplicationRef } from '@angular/core';
import { NativeKeyboardInsetAdapter } from '@trinity/platform-native';
import { Subject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationRuntimeService } from '../application-runtime.service';
import { DiagnosticMarkersBinding } from './diagnostic-markers.binding';
import { SessionHandoverWorkflow } from './session-handover.workflow';
import { startApplicationRuntime } from './start-application-runtime';

function fakeApplication() {
  const runtime = new Subject<never>();
  const markers = new Subject<never>();
  const handover = new Subject<never>();
  const keyboardInset = new Subject<never>();
  const stop = vi.fn(() => of(undefined));
  const handleError = vi.fn();
  const destroyers: (() => void)[] = [];
  const services = new Map<unknown, unknown>([
    [ApplicationRuntimeService, { run: () => runtime, stop }],
    [ErrorHandler, { handleError }],
    [DiagnosticMarkersBinding, { run: () => markers }],
    [SessionHandoverWorkflow, { run: () => handover }],
    [NativeKeyboardInsetAdapter, { follow: keyboardInset }],
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
    stop,
    handleError,
    destroy: () => destroyers.forEach((destroy) => destroy()),
  };
}

describe('startApplicationRuntime', () => {
  it('runs Application Runtime and the lifecycle markers for the life of the application', () => {
    const app = fakeApplication();

    startApplicationRuntime(app.applicationRef);

    expect(app.runtime.observed).toBe(true);
    expect(app.markers.observed).toBe(true);
    expect(app.handover.observed).toBe(true);
    expect(app.keyboardInset.observed).toBe(true);

    app.destroy();

    expect(app.runtime.observed).toBe(false);
    expect(app.markers.observed).toBe(false);
    expect(app.handover.observed).toBe(false);
    expect(app.keyboardInset.observed).toBe(false);
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
