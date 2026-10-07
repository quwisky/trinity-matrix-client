import { beforeAll, describe, expect, it, vi } from 'vitest';

// main.ts runs side-effectfully on import: it acquires the single-instance lock
// (return true so the `else` bootstrap branch runs) and calls
// `app.whenReady().then(cb)`. We capture that `cb` so the test can drive the
// startup sequence deterministically instead of racing microtasks.
// vi.hoisted so these exist when the hoisted vi.mock factories run.
const { appendSwitch, readyRef, requestSingleInstanceLock, whenReady } =
  vi.hoisted(() => ({
    appendSwitch: vi.fn(),
    readyRef: { cb: undefined as undefined | (() => void) },
    requestSingleInstanceLock: vi.fn(() => true),
    // Return a thenable that captures the ready callback (never auto-invokes it).
    whenReady: vi.fn(() => ({
      then: (cb: () => void) => {
        readyRef.cb = cb;
        return Promise.resolve();
      },
    })),
  }));

vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock,
    quit: vi.fn(),
    on: vi.fn(),
    setAppUserModelId: vi.fn(),
    commandLine: { appendSwitch },
    whenReady,
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
vi.mock('./cors-ipc', () => ({ registerCorsIpc: vi.fn() }));
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
vi.mock('./host-capabilities', () => ({
  registerHostCapabilityHandshake: vi.fn(),
}));
vi.mock('./title-bar-ipc', () => ({ registerTitleBarIpc: vi.fn() }));
vi.mock('./update-check', () => ({ startUpdateChecks: vi.fn() }));
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
import { registerHostCapabilityHandshake } from './host-capabilities';
import { registerTitleBarIpc } from './title-bar-ipc';
import { startUpdateChecks } from './update-check';

/** First invocation-order tick of a mock (a global monotonic counter in vitest,
 * so it's comparable ACROSS different mocks). */
function firstOrder(fn: { mock: { invocationCallOrder: number[] } }): number {
  return fn.mock.invocationCallOrder[0];
}

describe('main bootstrap', () => {
  // main.ts bootstraps once, as an import side effect, and every test below asserts on that
  // one run. Vitest 5 clears mock calls before each test by default, which would erase it.
  vi.setConfig({ clearMocks: false });

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
    expect(firstOrder(vi.mocked(registerPrivilegedScheme))).toBeLessThan(
      firstOrder(vi.mocked(registerAppProtocol)),
    );
  });

  it('caps the compositor tile budget before the app is ready', () => {
    expect(appendSwitch).toHaveBeenCalledWith(
      'force-gpu-mem-available-mb',
      '256',
    );
    expect(firstOrder(appendSwitch)).toBeLessThan(firstOrder(whenReady));
  });

  it('installs the CORS shim on session.defaultSession', () => {
    expect(installMatrixCors).toHaveBeenCalledTimes(1);
    expect(installMatrixCors).toHaveBeenCalledWith(session.defaultSession);
  });

  it('registers the dock-badge IPC handler at startup', () => {
    expect(registerDockBadge).toHaveBeenCalledTimes(1);
  });

  it('registers host negotiation before creating the renderer window', () => {
    expect(registerHostCapabilityHandshake).toHaveBeenCalledTimes(1);
    expect(firstOrder(vi.mocked(registerHostCapabilityHandshake))).toBeLessThan(
      firstOrder(vi.mocked(createWindow)),
    );
  });

  it('registers the title-bar IPC before creating the renderer window', () => {
    expect(registerTitleBarIpc).toHaveBeenCalledTimes(1);
    expect(firstOrder(vi.mocked(registerTitleBarIpc))).toBeLessThan(
      firstOrder(vi.mocked(createWindow)),
    );
  });

  it('installs CORS AFTER registerAppProtocol and BEFORE createWindow', () => {
    // The homeserver-traffic interceptor must be live on the default session
    // before the window loads its URL, and the app protocol must already be
    // serving trinity://app.
    expect(firstOrder(vi.mocked(registerAppProtocol))).toBeLessThan(
      firstOrder(vi.mocked(installMatrixCors)),
    );
    expect(firstOrder(vi.mocked(installMatrixCors))).toBeLessThan(
      firstOrder(vi.mocked(createWindow)),
    );
  });

  it('starts the update check once the window exists', () => {
    expect(startUpdateChecks).toHaveBeenCalledTimes(1);
    expect(firstOrder(vi.mocked(createWindow))).toBeLessThan(
      firstOrder(vi.mocked(startUpdateChecks)),
    );
  });
});
