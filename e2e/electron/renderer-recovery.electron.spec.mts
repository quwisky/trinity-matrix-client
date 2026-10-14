import { type ElectronApplication } from 'playwright';
import { expect, test } from './fixtures.mts';
import { launchApp } from './support/launch.mts';

// Release builds have no View › Reload, so the shell itself brings back a crashed or
// hung renderer (electron/src/renderer-recovery.ts). Only the crash is a journey: with
// Playwright's debugger attached to the renderer, Chromium never reports it unresponsive,
// so the hang path is covered by renderer-recovery.spec.ts.

let app: ElectronApplication;

test.beforeEach(async () => {
  app = await launchApp();
  const page = await app.firstWindow();
  await expect(page.getByLabel('Homeserver')).toBeVisible();
  // What main saw, for a failure message: renderer exits (with whether the window was on
  // screen) and finished loads.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const events: string[] = [];
    Object.assign(globalThis, { rendererRecoveryEvents: events });
    win?.webContents.on(
      'render-process-gone',
      (_event: unknown, details: { reason: string }) =>
        events.push(
          `gone ${details.reason} visible=${win.isVisible()} minimized=${win.isMinimized()}`,
        ),
    );
    win?.webContents.on('did-finish-load', () => events.push('loaded'));
  });
});

/** Wait for a new renderer with the sign-in form; a timeout names what main saw. */
async function expectRecovered(): Promise<void> {
  try {
    await expect.poll(rendererState, { timeout: 30_000 }).toBe('sign-in shown');
  } catch (error) {
    const seen = await app.evaluate(() =>
      JSON.stringify({
        events:
          (globalThis as { rendererRecoveryEvents?: string[] })
            .rendererRecoveryEvents ?? [],
        asked:
          (globalThis as { rendererRecoveryAsked?: string[] })
            .rendererRecoveryAsked ?? [],
      }),
    );
    throw new Error(`${String(error)}\nmain saw: ${seen}`);
  }
}

test.afterEach(async () => {
  await app?.close();
});

/**
 * What the window's current renderer shows, asked from main: the Playwright page of a
 * crashed renderer cannot be used again. A poll's failure names the last state.
 */
function rendererState(): Promise<string> {
  return app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents;
    // Not isCrashed(): Linux keeps reporting the crash after the reload. Not isLoading()
    // either: the marker below already tells the new renderer from the crashed one.
    if (!contents) return 'no window';
    const page = contents
      .executeJavaScript(
        `({ marked: window.__beforeRecovery === true, signIn: document.body?.textContent?.includes('Homeserver') === true })`,
      )
      .then((answer: { marked: boolean; signIn: boolean }) =>
        answer.marked
          ? 'the crashed renderer'
          : answer.signIn
            ? 'sign-in shown'
            : 'no sign-in form',
      )
      .catch((error: unknown) => `script failed: ${String(error)}`);
    const late = new Promise<string>((resolve) =>
      setTimeout(() => resolve('script did not answer'), 2_000),
    );
    return Promise.race([page, late]);
  });
}

/** Mark the renderer, so the check above only passes in a new one. */
async function markRenderer(): Promise<void> {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript(
      'window.__beforeRecovery = true',
    ),
  );
}

test('reloads the window after its renderer crashes', async () => {
  await markRenderer();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer(),
  );

  await expectRecovered();
});

test('asks after a crash soon after the last reload, and reloads on Reload', async () => {
  // Answer the native question with Reload, and keep what it asked.
  await app.evaluate(({ dialog }) => {
    const asked: string[] = [];
    Object.assign(globalThis, { rendererRecoveryAsked: asked });
    dialog.showMessageBox = (async (...args: unknown[]) => {
      asked.push((args.at(-1) as { message: string }).message);
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  const asked = () =>
    app.evaluate(
      () =>
        (globalThis as { rendererRecoveryAsked?: string[] })
          .rendererRecoveryAsked ?? [],
    );
  const crash = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer(),
    );

  await markRenderer();
  await crash();
  await expectRecovered();
  expect(await asked()).toEqual([]);

  await markRenderer();
  await crash();
  // Wait for main to see the exit: on Linux the renderer crashes itself on an IPC, so
  // bringing the window forward any earlier would find nothing waiting to be asked.
  await expect
    .poll(
      () =>
        app.evaluate(
          () =>
            (
              (globalThis as { rendererRecoveryEvents?: string[] })
                .rendererRecoveryEvents ?? []
            ).filter((event) => event.startsWith('gone ')).length,
        ),
      { timeout: 15_000 },
    )
    .toBe(2);
  // Bring the window forward, as a person coming back to it would. Linux CI (xvfb, no
  // window manager) reports the window hidden, so the question waits for this.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.show();
    win?.focus();
  });
  await expectRecovered();
  expect(await asked()).toEqual([
    expect.stringMatching(/^Trinity( Next)? stopped working$/),
  ]);
});
