import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

async function waitForDexSurface(
  device: MaestroDevice,
  workspaceRoot: string,
  signal: AbortSignal,
): Promise<DexSurfaceProof> {
  signal.throwIfAborted();
  await device.runFlow(
    join(workspaceRoot, 'e2e/android/flows/legacy-sso-dex-ready.yaml'),
  );
  signal.throwIfAborted();
  const hierarchy = await device.adb(
    'exec-out',
    'uiautomator',
    'dump',
    '/dev/tty',
  );
  assert(
    nativeNodes(hierarchy).some((node) => node.package === CHROME_PACKAGE),
    'Dex surface is hosted by the native Chrome package',
  );
  return {
    package: CHROME_PACKAGE,
    hasLogin: true,
    hasPassword: true,
    hasSubmit: true,
  };
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
      workspaceRoot,
      AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
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
        await device.runFlow(
          join(
            workspaceRoot,
            'e2e/android/flows/legacy-sso-chrome-setup.yaml',
          ),
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
              commandLineFirstRunBypassRequested: true,
              firstRunHandledNatively: true,
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
