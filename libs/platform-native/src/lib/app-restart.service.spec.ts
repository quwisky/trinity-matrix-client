import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRestartService } from './app-restart.service';

/**
 * Swap `window.location` for a recorder. jsdom implements neither `replace` nor `reload`,
 * and `test-setup.base.ts` filters its "Not implemented: navigation" noise — so without a
 * stand-in these assertions would be silently unobservable in both directions.
 */
function stubLocation(href: string) {
  const original = Object.getOwnPropertyDescriptor(window, 'location');
  const calls: string[] = [];
  Object.defineProperty(window, 'location', {
    value: {
      href,
      replace: (url: string) => calls.push(`replace:${url}`),
      assign: (url: string) => calls.push(`assign:${url}`),
      reload: () => calls.push('reload'),
    },
    writable: true,
    configurable: true,
  });
  return {
    calls,
    restore: () => {
      if (original) {
        Object.defineProperty(window, 'location', original);
      }
    },
  };
}

describe('AppRestartService', () => {
  let stub: ReturnType<typeof stubLocation> | undefined;

  afterEach(() => {
    stub?.restore();
    stub = undefined;
    vi.restoreAllMocks();
  });

  const service = () => {
    TestBed.configureTestingModule({ providers: [AppRestartService] });
    return TestBed.inject(AppRestartService);
  };

  it('replaces with the app root, dropping the current query', () => {
    // Not `reload()`, which is the whole reason this wrapper exists. After a factory reset
    // the URL may still carry `?add` or `?reauth=<userId>`, and re-entering the login page
    // with those against an empty registry reports "That account is no longer stored." for
    // an account the user just chose to erase.
    stub = stubLocation('https://app.example/login?reauth=@a:hs');

    service().restart();

    expect(stub.calls).toEqual(['replace:https://app.example/']);
  });

  it('never reloads in place, which would keep the dead URL', () => {
    stub = stubLocation('https://app.example/login?add');

    service().restart();

    expect(stub.calls.some((c) => c === 'reload')).toBe(false);
  });

  it('resolves the root against a custom scheme, for Electron and native', () => {
    // Electron's renderer runs on `trinity://app` and Capacitor serves `capacitor://localhost`
    // — the root has to be derived from the current href rather than hard-coded to a
    // https origin, or the restart navigates nowhere on both.
    stub = stubLocation('trinity://app/login?add');

    service().restart();

    expect(stub.calls).toEqual(['replace:trinity://app/']);
  });
});
