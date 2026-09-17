import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { MaestroDevice } from './maestro-session.mts';

const CHROME_PACKAGE = 'com.android.chrome';
const TRINITY_COMPONENT =
  'eu.qwky.trinity/eu.qwky.trinity.MainActivity';
const CHROME_COMMAND_LINE = '/data/local/tmp/chrome-command-line';
const CHROME_FLAGS = [
  '_',
  '--disable-fre',
  '--no-default-browser-check',
  '--ignore-certificate-errors',
  '--host-resolver-rules=MAP localhost 127.0.0.1',
] as const;

interface NativeNode {
  readonly package: string;
  readonly resourceId: string;
  readonly text: string;
  readonly contentDescription: string;
  readonly className: string;
}

export interface DexSurfaceProof {
  readonly package: typeof CHROME_PACKAGE;
  readonly hasLogin: true;
  readonly hasPassword: true;
  readonly hasSubmit: true;
}

export interface DexCompletionProof extends DexSurfaceProof {
  readonly nativeActions: readonly ['email', 'password', 'submit'];
}

export interface LegacySsoProvider {
  prepare(): Promise<void>;
  waitForDex(): Promise<DexSurfaceProof>;
  completeDexSignIn(
    email: string,
    password: string,
  ): Promise<DexCompletionProof>;
  close(): Promise<void>;
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function nativeNodes(hierarchy: string): readonly NativeNode[] {
  return [...hierarchy.matchAll(/<node\b[^>]+>/gu)].map(([node]) => {
    const attributes = Object.fromEntries(
      [...node.matchAll(/([\w-]+)="([^"]*)"/gu)].map(([, key, value]) => [
        key,
        decodeXml(value ?? ''),
      ]),
    );
    return {
      package: attributes['package'] ?? '',
      resourceId: attributes['resource-id'] ?? '',
      text: attributes['text'] ?? '',
      contentDescription: attributes['content-desc'] ?? '',
      className: attributes['class'] ?? '',
    };
  });
}

function hasControl(nodes: readonly NativeNode[], id: string): boolean {
  return nodes.some(
    (node) =>
      node.package === CHROME_PACKAGE &&
      (node.resourceId === id ||
        node.resourceId.endsWith(`:id/${id}`) ||
        node.contentDescription === id ||
        node.text === id),
  );
}

async function waitForDexSurface(
  device: MaestroDevice,
  signal: AbortSignal,
): Promise<DexSurfaceProof> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const hierarchy = await device
      .adb('exec-out', 'uiautomator', 'dump', '/dev/tty')
      .catch(() => '');
    const nodes = nativeNodes(hierarchy);
    const hasLogin = hasControl(nodes, 'login');
    const hasPassword = hasControl(nodes, 'password');
    const hasSubmit = hasControl(nodes, 'submit-login');
    if (hasLogin && hasPassword && hasSubmit) {
      return {
        package: CHROME_PACKAGE,
        hasLogin: true,
        hasPassword: true,
        hasSubmit: true,
      };
    }
    await delay(100, undefined, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
    }).catch((error: unknown) => {
      signal.throwIfAborted();
      if (!(error instanceof DOMException && error.name === 'TimeoutError')) {
        throw error;
      }
    });
  }
  throw new Error('Timed out waiting for the pinned Dex native surface');
}

export async function openLegacySsoProvider(
  device: MaestroDevice,
  workspaceRoot: string,
  artifactDirectory: string,
  signal: AbortSignal,
): Promise<LegacySsoProvider> {
  let commandLinePresent = false;
  let closed = false;
  let prepared = false;

  const removeChromeCommandLine = async (): Promise<void> => {
    if (!commandLinePresent) return;
    await device.adb('shell', 'rm', '-f', CHROME_COMMAND_LINE);
    commandLinePresent = false;
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    try {
      await removeChromeCommandLine();
    } catch (error) {
      failures.push(error);
    }
    try {
      await device.adb('shell', 'am', 'force-stop', CHROME_PACKAGE);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) {
      throw new AggregateError(failures, 'Chrome provider cleanup failed');
    }
  };

  const waitForDex = async (): Promise<DexSurfaceProof> => {
    assert(prepared, 'SSO provider must be prepared before Dex observation');
    return waitForDexSurface(
      device,
      AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    );
  };

  signal.addEventListener(
    'abort',
    () => {
      void close().catch(() => undefined);
    },
    { once: true },
  );

  return {
    async prepare() {
      assert(!closed, 'Cannot prepare a closed SSO provider');
      assert(!prepared, 'SSO provider preparation is one-shot');
      signal.throwIfAborted();
      const failures: unknown[] = [];
      try {
        await device.adb('shell', 'am', 'force-stop', CHROME_PACKAGE);
        assert.equal(
          await device.adb('shell', 'pm', 'clear', CHROME_PACKAGE),
          'Success',
          'Disposable Chrome profile cleared',
        );
        const encoded = Buffer.from(CHROME_FLAGS.join(' ')).toString('base64');
        commandLinePresent = true;
        await device.adb(
          'shell',
          'sh',
          '-c',
          `echo ${encoded} | base64 -d > ${CHROME_COMMAND_LINE}`,
        );
        await device.adb(
          'shell',
          'am',
          'start',
          '-W',
          '-a',
          'android.intent.action.VIEW',
          '-d',
          'about:blank',
          CHROME_PACKAGE,
        );
        await removeChromeCommandLine();
        await device.adb(
          'shell',
          'am',
          'start',
          '-W',
          '-n',
          TRINITY_COMPONENT,
        );
        prepared = true;
        await writeFile(
          join(artifactDirectory, 'chrome-provider.json'),
          `${JSON.stringify(
            {
              package: CHROME_PACKAGE,
              profileCleared: true,
              firstRunDisabled: true,
              loopbackIpv4: true,
              disposableCertificateAccepted: true,
              driverInstalled: false,
            },
            null,
            2,
          )}\n`,
        );
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          await removeChromeCommandLine();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) {
        throw new AggregateError(
          failures,
          'Chrome provider preparation failed',
        );
      }
    },
    waitForDex,
    async completeDexSignIn(email, password) {
      const surface = await waitForDex();
      await device.runFlow(
        join(workspaceRoot, 'e2e/android/flows/legacy-sso-dex.yaml'),
        { DEX_EMAIL_SECRET: email, DEX_PASSWORD: password },
      );
      return {
        ...surface,
        nativeActions: ['email', 'password', 'submit'],
      };
    },
    close,
  };
}
