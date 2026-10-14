import type {
  AppLockCommandOutcome,
  AppLockPinState,
} from '@trinity/data-access/app-lock';
import type { HostPresenceBiometry } from '@trinity/runtime/host';

// Settings › Security › App lock's words (spec §1). Copy that names the app takes the running
// app's name. The method names repeat the lock screen's (features cannot import Application
// Runtime, which owns that copy).

/** What a guarded change was trying to do; it names what stayed as it was. */
export type AppLockChange = 'enable' | 'disable' | 'lock-after' | 'change-pin';

export type AppLockFailure = Extract<
  AppLockCommandOutcome,
  { kind: 'failed' }
>['reason'];

/** The system prompt in a sentence: "Unlock with Face ID". */
export function methodShortName(biometry: HostPresenceBiometry): string {
  switch (biometry) {
    case 'face':
      return 'Face ID';
    case 'touch-id':
      return 'Touch ID';
    case 'fingerprint':
      return 'your fingerprint';
    case 'windows-hello':
      return 'Windows Hello';
    case 'passcode-only':
      return 'your device passcode';
    default: {
      const unhandled: never = biometry;
      void unhandled;
      return 'your device’s unlock';
    }
  }
}

/**
 * Everything the system prompt accepts, for the forgotten-PIN warning: "If you can’t use Face
 * ID or your device passcode and you forget this PIN…". Windows Hello includes its own PIN.
 */
export function methodWarningName(biometry: HostPresenceBiometry): string {
  switch (biometry) {
    case 'face':
      return 'Face ID or your device passcode';
    case 'touch-id':
      return 'Touch ID or your device password';
    case 'fingerprint':
      return 'your fingerprint or your device’s screen lock';
    case 'windows-hello':
      return 'Windows Hello';
    case 'passcode-only':
      return 'your device passcode';
    default: {
      const unhandled: never = biometry;
      void unhandled;
      return 'your device’s unlock';
    }
  }
}

function unchanged(change: AppLockChange): string {
  switch (change) {
    case 'enable':
      return 'App lock is still off';
    case 'disable':
      return 'App lock is still on';
    case 'lock-after':
      return 'Lock after hasn’t changed';
    case 'change-pin':
      return 'your PIN hasn’t changed';
    default: {
      const unhandled: never = change;
      void unhandled;
      return 'nothing changed';
    }
  }
}

/** Why a change didn't happen, and that nothing half-changed. */
export function failureMessage(
  change: AppLockChange,
  reason: AppLockFailure,
  appName: string,
): string {
  const kept = unchanged(change);
  switch (reason) {
    case 'not-offered':
      return `${appName} can’t keep a PIN on this device right now, so ${kept}.`;
    case 'not-verified':
      return `${appName} couldn’t confirm it’s you, so ${kept}. Try again.`;
    case 'pin-invalid':
      return `A PIN needs 4 to 16 digits, so ${kept}. Try again.`;
    case 'pin-not-saved':
      return `${appName} couldn’t save your PIN, so ${kept}. Try again.`;
    case 'setting-not-saved':
      return `${appName} couldn’t save this setting, so ${kept}. Try again.`;
    default: {
      const unhandled: never = reason;
      void unhandled;
      return `${appName} couldn’t change App lock, so ${kept}. Try again.`;
    }
  }
}

/** A guarded change that needs the PIN while there is no PIN it can check. */
export function noPinToCheckMessage(
  pinState: Exclude<AppLockPinState, 'ready'>,
  appName: string,
): string {
  switch (pinState) {
    case 'unreadable':
      return `${appName} can’t read your PIN right now, so it can’t confirm it’s you. Try again.`;
    case 'not-set':
    case 'not-supported':
      return `There’s no ${appName} PIN on this device to confirm it’s you.`;
    default: {
      const unhandled: never = pinState;
      void unhandled;
      return `${appName} can’t confirm it’s you right now. Try again.`;
    }
  }
}

/** No PIN store: a desktop without usable encryption (Linux `basic_text`). */
export function keyringNote(appName: string): string {
  return `App lock needs secure storage to keep your PIN, and this device has none ${appName} can use. On Linux, set up your desktop’s keyring (GNOME Keyring or KWallet), then restart ${appName}.`;
}

/**
 * A PIN store that exists but can't be read (a damaged record, a locked keyring). With the
 * lock off the host refuses a new PIN over it, so only the full reset clears it.
 */
export function storedPinUnreadableNote(appName: string): string {
  return `${appName} can’t read the PIN stored on this device, so App lock can’t be turned on. Try again. If that doesn’t help, erasing all data on this device clears it: you’ll find Erase all data on this device on the sign-in screen.`;
}

/** The same with the lock on: the system prompt still confirms changes, else the reset. */
export function pinUnreadableNote(
  appName: string,
  method: string | null,
): string {
  return method
    ? `${appName} can’t read your PIN right now. Use ${method} to change App lock or turn it off.`
    : `${appName} can’t read your PIN right now. Try again. If that doesn’t help, lock ${appName} and choose Erase all data on this device on the lock screen.`;
}
