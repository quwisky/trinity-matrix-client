import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { remote, type Browser } from 'webdriverio';
import {
  openDevtoolsConnection,
  type DevtoolsConnection,
} from './devtools-connection.mts';

export const ELECTRON_CHROMEDRIVER_VERSION = '150.0.7871.129';

export interface ElectronBinaryPaths {
  readonly electron: string;
  readonly chromedriver: string;
}

export interface ElectronSessionOptions {
  readonly workspace: string;
  /** Entry point or unpacked application path for the supplied Electron binary. */
  readonly artifact: string;
  readonly profile?: string;
  readonly signal?: AbortSignal;
  readonly binaryPaths: ElectronBinaryPaths;
  readonly inspectorPort?: number;
  readonly diagnosticPath?: string;
  readonly closeTimeoutMs?: number;
}

export interface ElectronSession {
  readonly browser: Browser;
  /** Send Unicode through Electron's actual webContents CDP input path. */
  insertText(text: string): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;

async function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate an ephemeral localhost port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (exited = true): void => {
      if (timer) clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    child.once('exit', onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

function terminateOwnedProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // The process can exit between the state check and the signal.
  }
}

async function inspectorWebSocket(
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
  spawnError: () => Error | undefined = () => undefined,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (spawnError())
      throw new Error('Electron failed to start its inspector', {
        cause: spawnError(),
      });
    if (signal?.aborted)
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('Electron session cancelled while opening inspector');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const pages = (await response.json()) as Array<{
          webSocketDebuggerUrl?: unknown;
        }>;
        const url = pages.find(
          (page) => typeof page.webSocketDebuggerUrl === 'string',
        )?.webSocketDebuggerUrl;
        if (typeof url === 'string') return url;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Electron inspector did not open on port ${port}`, {
    cause: lastError,
  });
}

async function waitForDriver(
  child: ChildProcess,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
  initialError?: Error,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let startupError: Error | undefined = initialError;
  child.once('error', (error) => {
    startupError = error;
  });
  while (Date.now() < deadline) {
    if (signal?.aborted)
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('WebDriver startup cancelled');
    if (startupError)
      throw new Error('Electron ChromeDriver failed to start', {
        cause: startupError,
      });
    if (child.exitCode !== null)
      throw new Error(
        `Electron ChromeDriver exited before readiness (${child.exitCode})`,
      );
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Driver is still binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Electron ChromeDriver did not become ready on port ${port}`);
}

export async function closeElectronHost(
  browser: Pick<Browser, 'deleteSession'> | undefined,
  mainInspector: Pick<DevtoolsConnection, 'send' | 'close'> | undefined,
  process: ChildProcess,
  profile: string | undefined,
  timeoutMs: number,
): Promise<void> {
  let graceful = false;
  let gracefulFailure: Error | undefined;
  if (mainInspector) {
    try {
      const evaluation = await bounded(
        mainInspector.send('Runtime.evaluate', {
          expression:
            "process.getBuiltinModule('module').createRequire(process.cwd()+'/__research.cjs')('electron').session.defaultSession.flushStorageData();setTimeout(()=>process.getBuiltinModule('module').createRequire(process.cwd()+'/__research.cjs')('electron').app.quit(),300);true",
          awaitPromise: true,
          returnByValue: true,
        }),
        timeoutMs,
        'Electron app.quit request timed out',
      );
      if (
        evaluation &&
        typeof evaluation === 'object' &&
        'exceptionDetails' in evaluation &&
        evaluation.exceptionDetails
      ) {
        throw new Error('Electron app.quit evaluation failed', {
          cause: evaluation.exceptionDetails,
        });
      }
      graceful = true;
    } catch (error) {
      gracefulFailure =
        error instanceof Error ? error : new Error(String(error));
      // Fall through to the owned process-group kill below.
    }
  }
  // Close inspector connections before waiting for Electron to quit. This
  // rejects every pending CDP request while the renderer is still present.
  mainInspector?.close(new Error('Electron app quit requested'));
  try {
    await bounded(
      browser?.deleteSession() ?? Promise.resolve(),
      timeoutMs,
      'Electron inspector close timed out',
    );
  } catch {
    // The owned process is the final cleanup boundary.
  }
  if (!graceful) terminateOwnedProcess(process);
  const exited = await waitForExit(process, timeoutMs);
  let forcedFailure: Error | undefined;
  if (!exited) {
    forcedFailure = new Error(
      'Electron app.quit did not exit within the cleanup timeout',
    );
    process.kill('SIGKILL');
  }
  const confirmedExit = exited || (await waitForExit(process, timeoutMs));
  if (!confirmedExit)
    throw new Error('Electron process did not exit after bounded cleanup', {
      cause: gracefulFailure,
    });
  if (profile) rmSync(profile, { recursive: true, force: true });
  if (gracefulFailure) throw gracefulFailure;
  if (forcedFailure) throw forcedFailure;
}

/** Launch the supplied prebuilt Electron host and attach WebdriverIO over CDP. */
export async function openElectronSession(
  options: ElectronSessionOptions,
): Promise<ElectronSession> {
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error('Electron session cancelled before start');
  }
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const inspectorPort = options.inspectorPort ?? (await allocatePort());
  const rendererPort = await allocatePort();
  const driverPort = await allocatePort();
  const ownedProfile = options.profile
    ? undefined
    : mkdtempSync(join(tmpdir(), 'trinity-electron-'));
  const profile = options.profile ?? ownedProfile;
  const child = spawn(
    options.binaryPaths.electron,
    [
      options.artifact,
      '--no-sandbox',
      '--disable-gpu',
      `--remote-debugging-port=${rendererPort}`,
      `--inspect=127.0.0.1:${inspectorPort}`,
      `--user-data-dir=${profile}`,
    ],
    {
      cwd: options.workspace,
      detached: false,
      stdio: options.diagnosticPath ? ['ignore', 'pipe', 'pipe'] : 'ignore',
      env: { ...process.env, NX_DAEMON: 'false' },
    },
  );
  let childSpawnError: Error | undefined;
  child.once('error', (error) => {
    childSpawnError = error;
  });
  if (options.diagnosticPath)
    mkdirSync(dirname(options.diagnosticPath), { recursive: true });
  const diagnostics = options.diagnosticPath
    ? createWriteStream(options.diagnosticPath, { flags: 'a' })
    : undefined;
  if (diagnostics) {
    child.stdout?.pipe(diagnostics, { end: false });
    child.stderr?.pipe(diagnostics, { end: false });
  }
  const driver = spawn(
    options.binaryPaths.chromedriver,
    [`--port=${driverPort}`],
    {
      cwd: options.workspace,
      detached: false,
      stdio: 'ignore',
      env: { ...process.env, NX_DAEMON: 'false' },
    },
  );
  let driverSpawnError: Error | undefined;
  driver.once('error', (error) => {
    driverSpawnError = error;
  });
  const cancelStartup = (): void => {
    terminateOwnedProcess(child);
    terminateOwnedProcess(driver);
  };
  options.signal?.addEventListener('abort', cancelStartup, { once: true });
  let browser: Browser | undefined;
  let mainInspector: DevtoolsConnection | undefined;
  const closeAll = async (): Promise<void> => {
    const failures: unknown[] = [];
    try {
      await closeElectronHost(
        browser,
        mainInspector,
        child,
        ownedProfile,
        closeTimeoutMs,
      );
    } catch (error) {
      failures.push(error);
    }
    diagnostics?.end();
    terminateOwnedProcess(driver);
    if (!(await waitForExit(driver, closeTimeoutMs))) {
      driver.kill('SIGKILL');
      if (!(await waitForExit(driver, closeTimeoutMs)))
        failures.push(new Error('Electron ChromeDriver did not stop'));
    }
    if (failures.length)
      throw new AggregateError(failures, 'Electron cleanup failed');
  };
  try {
    const mainInspectorUrl = await inspectorWebSocket(
      inspectorPort,
      closeTimeoutMs,
      options.signal,
      () => childSpawnError,
    );
    mainInspector = await openDevtoolsConnection(mainInspectorUrl, {
      signal: options.signal,
      timeoutMs: closeTimeoutMs,
    });
    await waitForDriver(
      driver,
      driverPort,
      closeTimeoutMs,
      options.signal,
      driverSpawnError,
    );
    browser = await remote({
      hostname: '127.0.0.1',
      port: driverPort,
      logLevel: 'silent',
      connectionRetryCount: 0,
      connectionRetryTimeout: closeTimeoutMs,
      capabilities: {
        browserName: 'chrome',
        browserVersion: '150.0.7871.129',
        'wdio:enforceWebDriverClassic': true,
        'goog:chromeOptions': {
          debuggerAddress: `127.0.0.1:${rendererPort}`,
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--ignore-certificate-errors',
          ],
        },
        acceptInsecureCerts: true,
      },
    });
    if (options.signal?.aborted)
      throw new Error('Electron session cancelled during start');
    let closePromise: Promise<void> | undefined;
    let closeSession: (() => Promise<void>) | undefined;
    const cancelSession = (): void => {
      void closeSession?.().catch(() => undefined);
    };
    options.signal?.removeEventListener('abort', cancelStartup);
    options.signal?.addEventListener('abort', cancelSession, { once: true });
    const session: ElectronSession = {
      browser,
      async insertText(text: string): Promise<void> {
        if (closePromise) throw new Error('Electron session is closed');
        if (!mainInspector)
          throw new Error('Electron inspector is unavailable');
        const evaluation = await bounded(
          mainInspector.send('Runtime.evaluate', {
            expression: `process.getBuiltinModule('module').createRequire(process.cwd()+'/__research.cjs')('electron').BrowserWindow.getAllWindows()[0].webContents.insertText(${JSON.stringify(text)})`,
            awaitPromise: true,
            returnByValue: true,
          }),
          closeTimeoutMs,
          'Electron webContents.insertText timed out',
        );
        if (
          evaluation &&
          typeof evaluation === 'object' &&
          'exceptionDetails' in evaluation &&
          evaluation.exceptionDetails
        ) {
          throw new Error('Electron text insertion failed', {
            cause: evaluation.exceptionDetails,
          });
        }
      },
      async close(): Promise<void> {
        if (closePromise) return closePromise;
        options.signal?.removeEventListener('abort', cancelSession);
        closePromise = closeAll();
        return closePromise;
      },
    };
    closeSession = session.close;
    return session;
  } catch (error) {
    options.signal?.removeEventListener('abort', cancelStartup);
    try {
      await closeAll();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Electron startup and cleanup failed',
      );
    }
    throw error;
  }
}
