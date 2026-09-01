import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ErrorHandler,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

/**
 * The app is zoneless, so nothing forwards a rejected promise to `ErrorHandler` unless
 * `provideBrowserGlobalErrorListeners()` installs the window listeners: zone.js used to
 * do it through `NgZone.onUnhandledError`, and there is no zone.js here. Without it
 * TrinityErrorHandler only ever sees errors thrown *inside* Angular — which is exactly
 * the class of regression a `handleError(...)` unit test cannot detect.
 */
describe('global error listeners', () => {
  function dispatchHandled(event: Event, expectedError: Error): void {
    const virtualConsole = (
      window as unknown as {
        _virtualConsole: {
          emit(event: string, ...args: unknown[]): boolean;
        };
      }
    )._virtualConsole;
    const emit = virtualConsole.emit;
    const captured: unknown[] = [];
    virtualConsole.emit = function (
      eventName: string,
      ...args: unknown[]
    ): boolean {
      const error = args[0] as { type?: unknown; cause?: unknown } | undefined;
      if (
        eventName === 'jsdomError' &&
        error?.type === 'unhandled-exception' &&
        error.cause === expectedError
      ) {
        captured.push(error);
        return false;
      }
      return emit.call(this, eventName, ...args);
    };
    try {
      window.dispatchEvent(event);
    } finally {
      virtualConsole.emit = emit;
    }
    expect(captured.length).toBeGreaterThan(0);
  }

  function handlerSpy() {
    const handleError = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideBrowserGlobalErrorListeners(),
        { provide: ErrorHandler, useValue: { handleError } },
      ],
    });
    // Forces the environment initializer (and therefore the listeners) to run.
    TestBed.inject(ErrorHandler);
    return handleError;
  }

  it('forwards an unhandled rejection to the ErrorHandler', () => {
    const handleError = handlerSpy();
    const reason = new Error('sync failed');
    const promise = Promise.reject(reason);
    promise.catch(() => undefined); // the event is synthetic; don't leave a real rejection

    const event = new PromiseRejectionEvent('unhandledrejection', {
      cancelable: true,
      promise,
      reason,
    });
    dispatchHandled(event, reason);

    // The RAW reason, not a `{ rejection }` envelope: that shape was zone.js's, and
    // anything unwrapping it is now reading a property that is never there.
    expect(handleError).toHaveBeenCalledWith(reason);
  });

  it('forwards a window error event to the ErrorHandler', () => {
    const handleError = handlerSpy();
    const error = new Error('render failed');

    const event = new ErrorEvent('error', { cancelable: true, error });
    dispatchHandled(event, error);

    expect(handleError).toHaveBeenCalledWith(error);
  });

  // `bootstrapApplication` cannot run in a spec, so pin the app to the deep provider
  // interface whose own tests and source-shape contract cover the concrete listener.
  it('is provided through the application composition module', () => {
    // Vitest runs with the project directory as its cwd (vite `root`), and
    // `import.meta.url` here is a dev-server URL rather than a file: one.
    const main = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');

    expect(main).toContain('provideTrinityApplication({');
  });
});
