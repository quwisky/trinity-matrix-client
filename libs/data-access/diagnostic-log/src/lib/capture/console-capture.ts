import { formatLogArgs } from './format-log-args';

export type ConsoleCaptureLevel = 'warn' | 'error';
export type WindowErrorKind = 'error' | 'unhandledrejection';

/**
 * Wrap `console.warn` and `console.error` so each call is also written, then passed through
 * unchanged. A writer that throws never stops the console. Returns the uninstall, which
 * restores a method only if it is still the wrapper.
 */
export function installConsoleCapture(
  target: Console,
  write: (level: ConsoleCaptureLevel, args: readonly unknown[]) => void,
): () => void {
  const restores = (['warn', 'error'] as const).map((level) => {
    const original = target[level];
    const wrapper = function (this: unknown, ...args: unknown[]): void {
      try {
        write(level, args);
      } catch {
        // Capture must never break the console.
      }
      original.apply(this, args);
    };
    target[level] = wrapper;
    return () => {
      if (target[level] === wrapper) {
        target[level] = original;
      }
    };
  });
  return () => restores.forEach((restore) => restore());
}

/** Record uncaught errors and unhandled rejections. Returns the uninstall. */
export function installWindowErrorCapture(
  target: Window,
  write: (kind: WindowErrorKind, message: string) => void,
): () => void {
  const onError = (event: ErrorEvent): void => {
    const where = event.filename
      ? ` (${event.filename}:${event.lineno}:${event.colno})`
      : '';
    write(
      'error',
      event.error !== undefined && event.error !== null
        ? formatLogArgs([event.error])
        : `${event.message}${where}`,
    );
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    write('unhandledrejection', formatLogArgs([event.reason]));
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}
