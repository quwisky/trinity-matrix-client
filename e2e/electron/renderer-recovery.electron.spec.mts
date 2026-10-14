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
});

test.afterEach(async () => {
  await app?.close();
});

/**
 * Whether the window's current renderer shows the sign-in form, asked from main: the
 * Playwright page of a crashed renderer cannot be used again.
 */
function signInShown(): Promise<boolean> {
  return app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!contents || contents.isCrashed() || contents.isLoading()) return false;
    return contents
      .executeJavaScript(
        `document.body?.textContent?.includes('Homeserver') && window.__beforeRecovery !== true`,
      )
      .catch(() => false) as Promise<boolean>;
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

  await expect.poll(signInShown, { timeout: 30_000 }).toBe(true);
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
  await expect.poll(signInShown, { timeout: 30_000 }).toBe(true);
  expect(await asked()).toEqual([]);

  await markRenderer();
  await crash();
  await expect.poll(signInShown, { timeout: 30_000 }).toBe(true);
  expect(await asked()).toEqual([
    expect.stringMatching(/^Trinity( Next)? stopped working$/),
  ]);
});
