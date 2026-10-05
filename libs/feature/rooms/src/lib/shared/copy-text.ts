import type { TrnToastService } from '@trinity/components/overlay';

/**
 * Copy `text` and toast the outcome once the write settles — never before. A missing
 * Clipboard API (insecure origin, old WebView) or a refused permission toasts a failure
 * instead of claiming a copy. `what` names the value in sentence case ("Room ID").
 */
export function copyText(
  text: string,
  what: string,
  toast: TrnToastService,
): void {
  let write: Promise<void>;
  try {
    write =
      typeof navigator.clipboard?.writeText === 'function'
        ? navigator.clipboard.writeText(text)
        : Promise.reject(new Error('Clipboard API unavailable'));
  } catch (error) {
    write = Promise.reject(error);
  }
  const lower = what.charAt(0).toLowerCase() + what.slice(1);
  void write.then(
    () => toast.show(`${what} copied.`, { duration: 2000 }),
    () => toast.show(`Could not copy the ${lower}.`, { duration: 2000 }),
  );
}
