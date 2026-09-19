import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { MaestroDevice } from './maestro-session.mts';
import { openMaestroWebview, type MaestroWebview } from './maestro-webview.mts';

export type NativeShellApplicationId =
  | 'eu.qwky.trinity'
  | 'eu.qwky.trinity.secondary';

export interface NativeShellSurface {
  readonly url: string;
  readonly body: string;
  readonly visibility: DocumentVisibilityState | string;
  readonly composer: string | null;
  readonly activeElement: string;
  readonly selection: { readonly start: number; readonly end: number } | null;
  readonly visualViewport: {
    readonly width: number;
    readonly height: number;
    readonly offsetTop: number;
    readonly offsetLeft: number;
  };
}

export interface NativeShellUiState {
  readonly homeserverVisible: boolean;
  readonly continueVisible: boolean;
  readonly settingsHeadingVisible: boolean;
  readonly settingsSectionsVisible: boolean;
  readonly appearanceLinkVisible: boolean;
  readonly appearanceLinkHeight: number;
  readonly roomsVisible: boolean;
  readonly roomsRailCurrent: string | null;
  readonly visibleRoomNames: readonly string[];
  readonly membersVisible: boolean;
  readonly composerVisible: boolean;
  readonly insertTriggerFocused: boolean;
  readonly insertExpanded: string | null;
  readonly sheetVisible: boolean;
  readonly formatCancelVisible: boolean;
  readonly formatCancelCount: number;
  readonly layoutViewport: { readonly width: number; readonly height: number };
  readonly sheetRect: { readonly x: number; readonly y: number; readonly right: number; readonly bottom: number } | null;
  readonly appearanceHeadingFocused: boolean;
  readonly appearanceLinkFocused: boolean;
}

export async function evaluateNative(
  webview: MaestroWebview,
  expression: string,
): Promise<unknown> {
  const response = await webview.diagnostics.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  assert(response && typeof response === 'object');
  if ('exceptionDetails' in response)
    assert.fail(`Android observation failed: ${JSON.stringify(response)}`);
  assert('result' in response);
  const result = response.result;
  assert(result && typeof result === 'object' && 'value' in result);
  return result.value;
}

export async function waitForNativeShellState<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  description: string,
  signal: AbortSignal,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let interruptedReads = 0;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    let value: T;
    try {
      value = await read();
    } catch (error) {
      signal.throwIfAborted();
      // Read-only polling can meet an Activity/WebView recreation. Never put
      // navigation, native input, or any other mutation in this callback.
      if (!(error instanceof Error) || error.message !== 'DevTools websocket closed unexpectedly') throw error;
      interruptedReads++;
      console.warn(`[native-shell] ${description}: interrupted observation ${interruptedReads}`);
      await delay(100, undefined, { signal });
      continue;
    }
    if (accepts(value)) return value;
    await delay(100, undefined, { signal });
  }
  throw new Error(`Timed out waiting for ${description} (${interruptedReads} interrupted observations)`);
}

export async function navigateNativeShell(
  webview: MaestroWebview,
  url: string,
  signal: AbortSignal,
  timeoutMs = 60_000,
): Promise<{ readonly url: string; readonly timeOrigin: number }> {
  const readDocument = async (): Promise<{ readonly url: string; readonly timeOrigin: number }> => {
    const value = await evaluateNative(webview, '({ url: location.href, timeOrigin: performance.timeOrigin })');
    assert(value && typeof value === 'object' && 'url' in value && typeof value.url === 'string' && 'timeOrigin' in value && typeof value.timeOrigin === 'number');
    return { url: value.url, timeOrigin: value.timeOrigin };
  };
  const before = await waitForNativeShellState(readDocument, () => true, 'document before protected navigation', signal, timeoutMs);
  const navigation = await webview.diagnostics.send('Page.navigate', { url });
  assert(navigation && typeof navigation === 'object' && !('errorText' in navigation) && 'loaderId' in navigation && typeof navigation.loaderId === 'string' && navigation.loaderId.length > 0, 'Protected navigation must start a new document successfully');
  return waitForNativeShellState(readDocument, (value) => value.timeOrigin !== before.timeOrigin, 'new document after protected navigation', signal, timeoutMs);
}

export async function readNativeShellSurface(
  webview: MaestroWebview,
): Promise<NativeShellSurface> {
  const value = await evaluateNative(
    webview,
    `(() => {
      const active = document.activeElement;
      const composer = document.querySelector('[data-testid="composer-input"]');
      const viewport = window.visualViewport;
      return {
        url: location.href,
        body: document.body?.innerText ?? '',
        visibility: document.visibilityState,
        composer: composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement ? composer.value : null,
        activeElement: active instanceof HTMLElement ? (active.dataset.testid ?? (active.id || null) ?? active.getAttribute('aria-label') ?? active.tagName.toLowerCase()) : '',
        selection: composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement ? { start: composer.selectionStart ?? 0, end: composer.selectionEnd ?? 0 } : null,
        visualViewport: { width: viewport?.width ?? innerWidth, height: viewport?.height ?? innerHeight, offsetTop: viewport?.offsetTop ?? 0, offsetLeft: viewport?.offsetLeft ?? 0 }
      };
    })()`,
  );
  assert(value && typeof value === 'object');
  assert('url' in value && typeof value.url === 'string');
  assert('body' in value && typeof value.body === 'string');
  assert('visibility' in value && typeof value.visibility === 'string');
  assert('composer' in value && (value.composer === null || typeof value.composer === 'string'));
  assert('activeElement' in value && typeof value.activeElement === 'string');
  assert('selection' in value && (value.selection === null || typeof value.selection === 'object'));
  assert('visualViewport' in value && typeof value.visualViewport === 'object');
  const viewport = value.visualViewport as Record<string, unknown>;
  assert(typeof viewport.width === 'number' && typeof viewport.height === 'number');
  assert(typeof viewport.offsetTop === 'number' && typeof viewport.offsetLeft === 'number');
  const selection = value.selection as Record<string, unknown> | null;
  if (selection)
    assert(typeof selection.start === 'number' && typeof selection.end === 'number');
  return {
    url: value.url,
    body: value.body,
    visibility: value.visibility,
    composer: value.composer,
    activeElement: value.activeElement,
    selection: selection
      ? { start: selection.start as number, end: selection.end as number }
      : null,
    visualViewport: {
      width: viewport.width as number,
      height: viewport.height as number,
      offsetTop: viewport.offsetTop as number,
      offsetLeft: viewport.offsetLeft as number,
    },
  };
}

export async function readNativeShellUiState(
  webview: MaestroWebview,
): Promise<NativeShellUiState> {
  const value = await evaluateNative(
    webview,
    `(() => {
      const sheet = document.querySelector('[data-testid="action-sheet-surface"]');
      const sheetBox = sheet?.getBoundingClientRect();
      const visible = (element) => {
        if (!element) return false;
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility === 'visible';
      };
      const insert = document.querySelector('[data-testid="composer-insert"]');
      const appearance = document.querySelector('[data-testid="settings-nav-appearance"]');
      const heading = document.querySelector('header[data-trn-layout="page"] h1');
      const appearanceHeading = document.querySelector('#appearance-heading');
      const homeserver = [...document.querySelectorAll('input')].find((input) =>
        input.getAttribute('aria-label') === 'Homeserver' || [...(input.labels ?? [])].some((label) => label.textContent?.trim() === 'Homeserver'));
      return {
        homeserverVisible: visible(homeserver),
        continueVisible: [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Continue' && visible(button)),
        settingsHeadingVisible: visible(heading) && heading.textContent?.trim() === 'Settings',
        settingsSectionsVisible: visible(document.querySelector('nav[aria-label="Settings sections"]')),
        appearanceLinkVisible: visible(appearance),
        appearanceLinkHeight: appearance?.getBoundingClientRect().height ?? 0,
        roomsVisible: visible(document.querySelector('trn-rooms')),
        roomsRailCurrent: document.querySelector('[data-testid="rail-rooms"]')?.getAttribute('aria-current') ?? null,
        visibleRoomNames: [...document.querySelectorAll('button.channel')].filter(visible).map((button) => button.textContent ?? ''),
        membersVisible: visible(document.querySelector('.chat-members')),
        composerVisible: visible(document.querySelector('[data-testid="composer-input"]')),
        insertTriggerFocused: document.activeElement === insert,
        insertExpanded: insert?.getAttribute('aria-expanded') ?? null,
        sheetVisible: visible(sheet),
        formatCancelVisible: visible(document.querySelector('[data-testid="format-cancel"]')),
        formatCancelCount: document.querySelectorAll('[data-testid="format-cancel"]').length,
        layoutViewport: { width: innerWidth, height: innerHeight },
        sheetRect: sheetBox ? { x: sheetBox.x, y: sheetBox.y, right: sheetBox.right, bottom: sheetBox.bottom } : null,
        appearanceHeadingFocused: document.activeElement === appearanceHeading && appearanceHeading?.textContent?.trim() === 'Appearance',
        appearanceLinkFocused: document.activeElement === appearance
      };
    })()`,
  );
  assert(value && typeof value === 'object');
  return value as NativeShellUiState;
}

export async function startNativeShellClient(
  device: MaestroDevice,
  applicationId: NativeShellApplicationId,
  signal: AbortSignal,
): Promise<{ readonly pid: string; readonly webview: MaestroWebview }> {
  await device.adb(
    'shell',
    'am',
    'start',
    '-n',
    `${applicationId}/eu.qwky.trinity.MainActivity`,
  );
  const webview = await openMaestroWebview(device, { applicationId, signal });
  return { pid: webview.pid, webview };
}

export async function captureNativeShellProof(
  device: MaestroDevice,
  webview: MaestroWebview,
  artifactDirectory: string,
  name: string,
): Promise<void> {
  await writeFile(
    join(artifactDirectory, `${name}-ui.json`),
    `${JSON.stringify(await readNativeShellUiState(webview), null, 2)}\n`,
  );
  await writeFile(
    join(artifactDirectory, `${name}.json`),
    `${JSON.stringify(await readNativeShellSurface(webview), null, 2)}\n`,
  );
  const response = await webview.diagnostics.send('Page.captureScreenshot', {
    format: 'png',
  });
  assert(response && typeof response === 'object' && 'data' in response);
  assert(typeof response.data === 'string');
  await writeFile(join(artifactDirectory, `${name}-webview.png`), Buffer.from(response.data, 'base64'));
  await writeFile(
    join(artifactDirectory, `${name}-device.png`),
    Buffer.from(
      await device.adb(
        'exec-out',
        'sh',
        '-c',
        'screencap -p | base64 -w 0',
      ),
      'base64',
    ),
  );
}

export async function readNativeStatusBar(webview: MaestroWebview): Promise<{
  readonly height: number;
  readonly overlays: boolean;
  readonly style: string;
  readonly visible: boolean;
}> {
  const value = await evaluateNative(
    webview,
    `window.Capacitor?.Plugins?.StatusBar?.getInfo?.() ?? null`,
  );
  assert(value && typeof value === 'object');
  assert('height' in value && typeof value.height === 'number');
  assert('overlays' in value && typeof value.overlays === 'boolean');
  assert('style' in value && typeof value.style === 'string');
  assert('visible' in value && typeof value.visible === 'boolean');
  return value as {
    height: number;
    overlays: boolean;
    style: string;
    visible: boolean;
  };
}
