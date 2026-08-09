import { ErrorHandler } from '@angular/core';
import { ConnectionError, HTTPError } from '@trinity/util/matrix';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrinityErrorHandler } from './trinity-error-handler';

describe('TrinityErrorHandler', () => {
  let handler: TrinityErrorHandler;
  let superSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    handler = new TrinityErrorHandler();
    // super.handleError resolves to the base prototype method.
    superSpy = vi
      .spyOn(ErrorHandler.prototype, 'handleError')
      .mockImplementation(() => undefined);
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('swallows a transient homeserver error, logging it quietly', () => {
    handler.handleError(new HTTPError('503', 503));

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(superSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('swallows a transient error delivered as a raw rejection reason', () => {
    // What provideBrowserGlobalErrorListeners() hands us: PromiseRejectionEvent.reason
    // itself. The `{ rejection, promise }` envelope this once unwrapped was zone.js's,
    // and this app has no zone.js — see global-error-listeners.spec.ts for the wiring.
    handler.handleError(new ConnectionError('fetch failed'));

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(superSpy).not.toHaveBeenCalled();
  });

  it('delegates a genuine error to the default handler', () => {
    const genuine = new TypeError('x');

    handler.handleError(genuine);

    expect(superSpy).toHaveBeenCalledTimes(1);
    expect(superSpy).toHaveBeenCalledWith(genuine);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('delegates a non-transient (4xx) Matrix error to the default handler', () => {
    const clientError = new HTTPError('bad request', 400);

    handler.handleError(clientError);

    expect(superSpy).toHaveBeenCalledTimes(1);
    expect(superSpy).toHaveBeenCalledWith(clientError);
    expect(debugSpy).not.toHaveBeenCalled();
  });
});
