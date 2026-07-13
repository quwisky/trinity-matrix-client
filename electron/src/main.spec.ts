import { beforeAll, describe, expect, it, vi } from 'vitest';

// main.ts runs side-effectfully on import: it acquires the single-instance lock
// (return true so the `else` bootstrap branch runs) and calls
// `app.whenReady().then(cb)`. We capture that `cb` so the test can drive the
// startup sequence deterministically instead of racing microtasks.
// vi.hoisted so these exist when the hoisted vi.mock factories run.
const { readyRef, requestSingleInstanceLock } = vi.hoisted(() => ({
  readyRef: { cb: undefined as undefined | (() => void) },
  requestSingleInstanceLock: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock,
    quit: vi.fn(),
    on: vi.fn(),
    setAppUserModelId: vi.fn(),
    // Return a thenable that captures the ready callback (never auto-invokes it).
    whenReady: vi.fn(() => ({
      then: (cb: () => void) => {
        readyRef.cb = cb;
        return Promise.resolve();
      },
    })),
  },
  // Sentinel default session — installMatrixCors must receive exactly this.
  session: { defaultSession: { __brand: 'defaultSession' } },
}));

// Stub every sibling module main.ts pulls in, so importing it is pure wiring.
vi.mock('./scheme', () => ({
  registerPrivilegedScheme: vi.fn(),
  registerAppProtocol: vi.fn(),
}));
vi.mock('./cors', () => ({ installMatrixCors: vi.fn() }));
vi.mock('./menu', () => ({ buildMenu: vi.fn() }));
vi.mock('./window', () => ({
  createWindow: vi.fn(),
  focusMainWindow: vi.fn(),
  hardenContents: vi.fn(),
  installPermissionPolicy: vi.fn(),
  setQuitting: vi.fn(),
}));
vi.mock('./tray', () => ({ createTray: vi.fn() }));
vi.mock('./notifications', () => ({
  maybeSendStartupTestNotification: vi.fn(),
  registerNotificationIpc: vi.fn(),
}));
vi.mock('./secure-store-ipc', () => ({ registerSecureStoreIpc: vi.fn() }));
vi.mock('./geolocation-ipc', () => ({ registerGeolocationIpc: vi.fn() }));
vi.mock('./dock-badge', () => ({ registerDockBadge: vi.fn() }));
vi.mock('./deep-link', () => ({
  deepLinkFromArgv: vi.fn(),
  deliverDeepLink: vi.fn(),
  processDeepLinkQueue: vi.fn(),
  registerDeepLinkProtocol: vi.fn(),
}));

import { session } from 'electron';
import { registerAppProtocol, registerPrivilegedScheme } from './scheme';
import { installMatrixCors } from './cors';
import { createWindow } from './window';
import { registerDockBadge } from './dock-badge';

/** First invocation-order tick of a mock (a global monotonic counter in vitest,
 * so it's comparable ACROSS different mocks). */
function firstOrder(fn: ReturnType<typeof vi.fn>): number {
  return fn.mock.invocationCallOrder[0];
}

describe('main bootstrap', () => {
  beforeAll(async () => {
    // Importing runs the top-level side effects and captures the ready callback.
    await import('./main');
    // Drive the app.whenReady() body once, synchronously.
    expect(readyRef.cb).toBeTypeOf('function');
    readyRef.cb?.();
  });

  it('acquires the single-instance lock and registers the privileged scheme before ready', () => {
    expect(requestSingleInstanceLock).toHaveBeenCalled();
    // Registered as a top-level side effect (must run before app is ready).
    expect(registerPrivilegedScheme).toHaveBeenCalledTimes(1);
    expect(firstOrder(registerPrivilegedScheme)).toBeLessThan(
      firstOrder(registerAppProtocol),
    );
  });

  it('installs the CORS shim on session.defaultSession', () => {
    expect(installMatrixCors).toHaveBeenCalledTimes(1);
    expect(installMatrixCors).toHaveBeenCalledWith(session.defaultSession);
  });

  it('registers the dock-badge IPC handler at startup', () => {
    expect(registerDockBadge).toHaveBeenCalledTimes(1);
  });

  it('installs CORS AFTER registerAppProtocol and BEFORE createWindow', () => {
    // The homeserver-traffic interceptor must be live on the default session
    // before the window loads its URL, and the app protocol must already be
    // serving trinity://app.
    expect(firstOrder(registerAppProtocol)).toBeLessThan(
      firstOrder(installMatrixCors),
    );
    expect(firstOrder(installMatrixCors)).toBeLessThan(
      firstOrder(createWindow),
    );
  });
});
