import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { MaestroDevice } from './maestro-session.mts';
import { openMaestroWebview, type MaestroWebview } from './maestro-webview.mts';

export type AndroidApplicationId =
  'eu.qwky.trinity' | 'eu.qwky.trinity.secondary';

export interface AndroidSurface {
  readonly url: string;
  readonly body: string;
  readonly visibility: string;
  readonly composer: string | null;
  readonly messages: readonly { readonly id: string; readonly body: string }[];
}

export async function waitForAndroidState<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  description: string,
  signal: AbortSignal,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const value = await read();
    if (accepts(value)) return value;
    await delay(100, undefined, { signal });
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function evaluate(
  webview: MaestroWebview,
  expression: string,
): Promise<unknown> {
  const evaluation = await webview.diagnostics.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  assert(evaluation && typeof evaluation === 'object');
  if ('exceptionDetails' in evaluation)
    assert.fail(
      `Android observation failed: ${JSON.stringify(evaluation.exceptionDetails)}`,
    );
  assert('result' in evaluation);
  const result = evaluation.result;
  assert(result && typeof result === 'object' && 'value' in result);
  return result.value;
}

export async function readAndroidSurface(
  webview: MaestroWebview,
): Promise<AndroidSurface> {
  const value = await evaluate(
    webview,
    `({
    url: location.href,
    body: document.body?.innerText ?? '',
    visibility: document.visibilityState,
    composer: document.querySelector('[data-testid="composer-input"]')?.value ?? null,
    messages: Array.from(document.querySelectorAll('trn-message-row .msg__text')).map(node => ({
      id: node.closest('[data-mid]')?.getAttribute('data-mid') ?? '',
      body: node.innerText
    }))
  })`,
  );
  assert(value && typeof value === 'object');
  assert('url' in value && typeof value.url === 'string');
  assert('body' in value && typeof value.body === 'string');
  assert('visibility' in value && typeof value.visibility === 'string');
  assert(
    'composer' in value &&
      (value.composer === null || typeof value.composer === 'string'),
  );
  assert('messages' in value && Array.isArray(value.messages));
  const messages = value.messages.map((message: unknown) => {
    assert(message && typeof message === 'object');
    assert('id' in message && typeof message.id === 'string');
    assert('body' in message && typeof message.body === 'string');
    return { id: message.id, body: message.body };
  });
  return {
    url: value.url,
    body: value.body,
    visibility: value.visibility,
    composer: value.composer,
    messages,
  };
}

/** Observe durable native storage without exposing account credentials in diagnostics. */
export async function waitForAndroidAccount(
  device: MaestroDevice,
  applicationId: AndroidApplicationId,
  userId: string,
  signal: AbortSignal,
): Promise<{
  readonly userId: string;
  readonly deviceId: string;
  readonly cryptoPrefix: string;
}> {
  return waitForAndroidState(
    async () => {
      const xml = await device.adb(
        'shell',
        'run-as',
        applicationId,
        'cat',
        'shared_prefs/CapacitorStorage.xml',
      );
      const encoded = xml.match(
        /<string name="matrix.accounts">(.*?)<\/string>/s,
      )?.[1];
      if (!encoded) return undefined;
      const decoded = encoded
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&');
      const registry: unknown = JSON.parse(decoded);
      assert(registry && typeof registry === 'object');
      if (!('activeUserId' in registry) || registry.activeUserId !== userId)
        return undefined;
      assert('accounts' in registry && Array.isArray(registry.accounts));
      const account: unknown = registry.accounts.find(
        (entry: unknown) =>
          entry &&
          typeof entry === 'object' &&
          'userId' in entry &&
          entry.userId === userId,
      );
      assert(account && typeof account === 'object');
      assert('deviceId' in account && typeof account.deviceId === 'string');
      assert(
        'cryptoPrefix' in account && typeof account.cryptoPrefix === 'string',
      );
      return {
        userId,
        deviceId: account.deviceId,
        cryptoPrefix: account.cryptoPrefix,
      };
    },
    (value) => value !== undefined,
    `durable ${applicationId} account identity`,
    signal,
    15_000,
  ).then((identity) => {
    assert(identity);
    return identity;
  });
}

export async function readAndroidCryptoDatabases(
  webview: MaestroWebview,
): Promise<readonly string[]> {
  const value = await evaluate(
    webview,
    'indexedDB.databases().then(databases => databases.map(database => database.name))',
  );
  assert(
    Array.isArray(value) &&
      value.every((name: unknown) => typeof name === 'string'),
  );
  return value as string[];
}

export async function startAndroidClient(
  device: MaestroDevice,
  applicationId: AndroidApplicationId,
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

export async function captureAndroidSurface(
  webview: MaestroWebview,
  artifactDirectory: string,
  name: string,
): Promise<void> {
  await writeFile(
    join(artifactDirectory, `${name}.json`),
    JSON.stringify(await readAndroidSurface(webview), null, 2),
  );
  const response = await webview.diagnostics.send('Page.captureScreenshot', {
    format: 'png',
  });
  assert(
    response &&
      typeof response === 'object' &&
      'data' in response &&
      typeof response.data === 'string',
  );
  await writeFile(
    join(artifactDirectory, `${name}.png`),
    Buffer.from(response.data, 'base64'),
  );
}
