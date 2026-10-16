import {
  InjectionToken,
  inject,
  provideEnvironmentInitializer,
  type EnvironmentProviders,
} from '@angular/core';
import loglevel from 'loglevel';
import type { Logger as SdkLogger } from 'matrix-js-sdk/lib/logger';

/** Console verbosity for matrix-js-sdk: everything, or warnings and errors only. */
export type MatrixSdkLogLevel = 'debug' | 'warn';

/** The loglevel methods an SDK logger has. */
export type MatrixSdkLogMethod = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** One matrix-js-sdk log call, as the SDK made it. */
export interface MatrixSdkLogRecord {
  readonly method: MatrixSdkLogMethod;
  /** The loglevel logger name: `matrix`, or `matrix-<prefix>` for a child. */
  readonly logger: string;
  readonly args: readonly unknown[];
}

/**
 * Receives every SDK log call at debug and above, whatever the console level. It must not
 * throw; a throw is swallowed so the SDK carries on.
 */
export interface MatrixSdkLogSink {
  write(record: MatrixSdkLogRecord): void;
  /**
   * Runs the console print of a call already written, so a console capture can tell the
   * SDK's own echo from Trinity's warnings and skip it.
   */
  echo?(print: () => void): void;
}

/** Optional sink for {@link provideMatrixSdkLogging}; without one the SDK only prints. */
export const MATRIX_SDK_LOG_SINK = new InjectionToken<MatrixSdkLogSink>(
  'MATRIX_SDK_LOG_SINK',
);

/** A matrix-js-sdk logger as it exists at runtime: a `loglevel` logger with children. */
type SdkLoglevelLogger = loglevel.Logger & SdkLogger;
type MethodFactory = loglevel.Logger['methodFactory'];

// matrix-js-sdk names its root logger `matrix` and each child `matrix-<prefix>`.
const SDK_ROOT_LOGGER = 'matrix';

const METHOD_RANK: Readonly<Record<MatrixSdkLogMethod, number>> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

/**
 * Marks a factory this module already wrapped. The SDK copies a parent's factory to every
 * new child, so without the mark a grandchild would write each line to the sink twice.
 */
const SINK_AWARE = Symbol('matrixSdkSinkAware');

let sdkLogLevel: MatrixSdkLogLevel = 'debug';
let sdkSink: MatrixSdkLogSink | null = null;
const governed = new WeakSet<SdkLoglevelLogger>();

/**
 * Set how much matrix-js-sdk writes to the console, and where its full output goes.
 *
 * The SDK sets each of its loggers to DEBUG when it creates one, so lowering the root
 * logger alone is not enough: this applies the configuration to every SDK logger that
 * already exists, including the module-level children created on import, and to every
 * child the SDK creates afterwards. Call it at startup, before any client is created.
 *
 * With a `sink`, every logger is built at debug so the sink receives debug lines, and each
 * call is printed only at `level` and above. Without one, levels below `level` are not built.
 */
export function configureMatrixSdkLogging(
  level: MatrixSdkLogLevel,
  sink: MatrixSdkLogSink | null = null,
): void {
  sdkLogLevel = level;
  sdkSink = sink;
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
 * service can create a client, with the {@link MATRIX_SDK_LOG_SINK} the app provides.
 */
export function provideMatrixSdkLogging(
  level: MatrixSdkLogLevel,
): EnvironmentProviders {
  return provideEnvironmentInitializer(() =>
    configureMatrixSdkLogging(
      level,
      inject(MATRIX_SDK_LOG_SINK, { optional: true }),
    ),
  );
}

function govern(logger: SdkLoglevelLogger): void {
  logger.methodFactory = sinkAware(logger.methodFactory);
  // `persist: false` keeps the level out of localStorage, as the SDK does.
  // setLevel rebuilds the methods through the (wrapped) factory, so wrap first.
  logger.setLevel(sdkSink ? 'debug' : sdkLogLevel, false);
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

/** Wrap a factory so each built method writes to the sink and prints only at the console level. */
function sinkAware(factory: MethodFactory): MethodFactory {
  if ((factory as MethodFactory & { [SINK_AWARE]?: true })[SINK_AWARE]) {
    return factory;
  }
  const wrapped: MethodFactory = (methodName, level, loggerName) => {
    const print = factory(methodName, level, loggerName);
    const method = methodName as MatrixSdkLogMethod;
    const logger = String(loggerName);
    return function (this: unknown, ...args: unknown[]): void {
      const sink = sdkSink;
      if (sink) {
        try {
          sink.write({ method, logger, args });
        } catch {
          // Diagnostics must never break the SDK.
        }
      }
      if (METHOD_RANK[method] < METHOD_RANK[sdkLogLevel]) {
        return;
      }
      // `this` is the logger: the SDK's own factory reads `this.prefix`.
      if (sink?.echo) {
        sink.echo(() => print.apply(this, args));
      } else {
        print.apply(this, args);
      }
    };
  };
  Object.defineProperty(wrapped, SINK_AWARE, { value: true });
  return wrapped;
}
