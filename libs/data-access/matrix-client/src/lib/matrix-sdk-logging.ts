import {
  provideEnvironmentInitializer,
  type EnvironmentProviders,
} from '@angular/core';
import loglevel from 'loglevel';
import type { Logger as SdkLogger } from 'matrix-js-sdk/lib/logger';

/** Console verbosity for matrix-js-sdk: everything, or warnings and errors only. */
export type MatrixSdkLogLevel = 'debug' | 'warn';

/** A matrix-js-sdk logger as it exists at runtime: a `loglevel` logger with children. */
type SdkLoglevelLogger = loglevel.Logger & SdkLogger;

// matrix-js-sdk names its root logger `matrix` and each child `matrix-<prefix>`
// (`getPrefixedLogger` in matrix-js-sdk/lib/logger.js).
const SDK_ROOT_LOGGER = 'matrix';

let sdkLogLevel: MatrixSdkLogLevel = 'debug';
const governed = new WeakSet<SdkLoglevelLogger>();

/**
 * Set how much matrix-js-sdk writes to the console.
 *
 * The SDK sets each of its loggers to DEBUG when it creates one, so lowering the root
 * logger alone is not enough: this applies the level to every SDK logger that already
 * exists, including the module-level children created on import, and to every child the
 * SDK creates afterwards. Call it at startup, before any client is created.
 */
export function configureMatrixSdkLogging(level: MatrixSdkLogLevel): void {
  sdkLogLevel = level;
  for (const [name, logger] of Object.entries(loglevel.getLoggers())) {
    if (name === SDK_ROOT_LOGGER || name.startsWith(`${SDK_ROOT_LOGGER}-`)) {
      govern(logger as SdkLoglevelLogger);
    }
  }
}

/** The level last set by {@link configureMatrixSdkLogging}; `debug` until then. */
export function matrixSdkLogLevel(): MatrixSdkLogLevel {
  return sdkLogLevel;
}

/**
 * Apply {@link configureMatrixSdkLogging} when the root injector is created, before any
 * service can create a client.
 */
export function provideMatrixSdkLogging(
  level: MatrixSdkLogLevel,
): EnvironmentProviders {
  return provideEnvironmentInitializer(() => configureMatrixSdkLogging(level));
}

function govern(logger: SdkLoglevelLogger): void {
  // `persist: false` keeps the level out of localStorage, as the SDK does.
  logger.setLevel(sdkLogLevel, false);
  if (governed.has(logger)) {
    return;
  }
  governed.add(logger);
  const getChild = logger.getChild;
  logger.getChild = (namespace: string): SdkLogger => {
    const child = getChild(namespace) as SdkLoglevelLogger;
    govern(child);
    return child;
  };
}
