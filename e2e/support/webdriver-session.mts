import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { rmSync } from 'node:fs';
import { remote, type Browser } from 'webdriverio';

export const CHROMEDRIVER_VERSION = '153.0.8010.36';

export interface BrowserBinaryPaths {
  readonly chrome: string;
  readonly chromedriver: string;
}

export interface WebdriverSessionOptions {
  readonly workspace: string;
  /** URL to open after the WebDriver session is created. */
  readonly artifact: string;
  readonly profile?: string;
  readonly signal?: AbortSignal;
  readonly binaryPaths: BrowserBinaryPaths;
  readonly headless?: boolean;
  readonly closeTimeoutMs?: number;
}

export interface WebdriverSession {
  readonly browser: Browser;
  close(): Promise<void>;
}

interface OwnedProcess {
  readonly child: ChildProcess;
  readonly profile?: string;
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
      throw new Error('ChromeDriver failed to start', { cause: startupError });
    if (child.exitCode !== null)
      throw new Error(
        `ChromeDriver exited before readiness (${child.exitCode})`,
      );
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      if (response.ok) return;
    } catch {
      // Driver is still binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`ChromeDriver did not become ready on port ${port}`);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', finish);
    timer = setTimeout(() => {
      if (child.pid) {
        try {
          child.kill('SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
      if (child.exitCode !== null || child.signalCode !== null) finish();
      else {
        if (timer) clearTimeout(timer);
        resolve(false);
      }
    }, timeoutMs);
    timer.unref?.();
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

async function closeBrowser(
  browser: Browser | undefined,
  owned: OwnedProcess | undefined,
  timeoutMs: number,
): Promise<void> {
  try {
    await bounded(
      browser?.deleteSession() ?? Promise.resolve(),
      timeoutMs,
      'WebDriver session close timed out',
    );
  } catch {
    // Process cleanup below is the final ownership boundary.
  }
  if (owned) {
    terminateOwnedProcess(owned.child);
    const exited = await waitForExit(owned.child, timeoutMs);
    if (!exited) terminateOwnedProcess(owned.child);
    await waitForExit(owned.child, timeoutMs);
    if (owned.profile) rmSync(owned.profile, { recursive: true, force: true });
  }
}

/** Start Chrome through the explicitly supplied pinned ChromeDriver binary. */
export async function openChromeSession(
  options: WebdriverSessionOptions,
): Promise<WebdriverSession> {
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error('Chrome session cancelled before start');
  }
  const port = await allocatePort();
  const driver = spawn(options.binaryPaths.chromedriver, [`--port=${port}`], {
    cwd: options.workspace,
    detached: false,
    stdio: 'ignore',
    env: { ...process.env, NX_DAEMON: 'false' },
  });
  let driverSpawnError: Error | undefined;
  driver.once('error', (error) => {
    driverSpawnError = error;
  });
  const owned: OwnedProcess = { child: driver };
  let browser: Browser | undefined;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const cancelStartup = (): void => terminateOwnedProcess(driver);
  options.signal?.addEventListener('abort', cancelStartup, { once: true });
  try {
    await waitForDriver(
      driver,
      port,
      closeTimeoutMs,
      options.signal,
      driverSpawnError,
    );
    browser = await remote({
      hostname: '127.0.0.1',
      port,
      path: '/',
      logLevel: 'silent',
      capabilities: {
        browserName: 'chrome',
        browserVersion: '153.0.8010.36',
        'wdio:enforceWebDriverClassic': true,
        'goog:chromeOptions': {
          binary: options.binaryPaths.chrome,
          args: [
            ...(options.headless === false ? [] : ['--headless=new']),
            '--disable-dev-shm-usage',
            '--no-sandbox',
            '--ignore-certificate-errors',
            ...(options.profile ? [`--user-data-dir=${options.profile}`] : []),
          ],
        },
        acceptInsecureCerts: true,
      },
      connectionRetryCount: 0,
      connectionRetryTimeout: closeTimeoutMs,
    });
    if (options.signal?.aborted)
      throw new Error('Chrome session cancelled during start');
    await browser.url(options.artifact);
    let closePromise: Promise<void> | undefined;
    let closeSession: (() => Promise<void>) | undefined;
    const cancelSession = (): void => {
      void closeSession?.().catch(() => undefined);
    };
    options.signal?.removeEventListener('abort', cancelStartup);
    options.signal?.addEventListener('abort', cancelSession, { once: true });
    const session: WebdriverSession = {
      browser,
      async close(): Promise<void> {
        if (closePromise) return closePromise;
        options.signal?.removeEventListener('abort', cancelSession);
        closePromise = closeBrowser(browser, owned, closeTimeoutMs);
        return closePromise;
      },
    };
    closeSession = session.close;
    return session;
  } catch (error) {
    await closeBrowser(browser, owned, closeTimeoutMs);
    throw error;
  }
}
