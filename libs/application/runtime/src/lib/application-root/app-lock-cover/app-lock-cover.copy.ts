import type { InstallationResetOutcome } from '@trinity/data-access/accounts';
import type {
  HostPresenceBiometry,
  HostSystemPresenceUnavailableReason,
} from '@trinity/runtime/host';

// The lock screen's words (spec §2). Copy that names the app takes the running app's name.

/** The method's name in a sentence ("Face ID isn’t available."). */
function methodName(biometry: HostPresenceBiometry): string {
  switch (biometry) {
    case 'face':
      return 'Face ID';
    case 'touch-id':
      return 'Touch ID';
    case 'fingerprint':
      return 'Fingerprint unlock';
    case 'windows-hello':
      return 'Windows Hello';
    case 'passcode-only':
      return 'Your device passcode';
    default: {
      const unhandled: never = biometry;
      void unhandled;
      return 'Your device’s unlock';
    }
  }
}

export function unlockLabel(biometry: HostPresenceBiometry): string {
  switch (biometry) {
    case 'face':
      return 'Unlock with Face ID';
    case 'touch-id':
      return 'Unlock with Touch ID';
    case 'fingerprint':
      return 'Unlock with fingerprint';
    case 'windows-hello':
      return 'Unlock with Windows Hello';
    case 'passcode-only':
      return 'Unlock with your device passcode';
    default: {
      const unhandled: never = biometry;
      void unhandled;
      return 'Unlock';
    }
  }
}

export function useMethodLabel(biometry: HostPresenceBiometry): string {
  switch (biometry) {
    case 'face':
      return 'Use Face ID';
    case 'touch-id':
      return 'Use Touch ID';
    case 'fingerprint':
      return 'Use fingerprint';
    case 'windows-hello':
      return 'Use Windows Hello';
    case 'passcode-only':
      return 'Use device passcode';
    default: {
      const unhandled: never = biometry;
      void unhandled;
      return 'Use device unlock';
    }
  }
}

/**
 * Why the system prompt isn't offered, naming the method the cover last saw (`method`), with
 * no OS text. Null where the PIN is simply how this device unlocks (no system prompt here, or
 * Windows 10), which needs no explaining.
 */
export function fallbackLine(
  reason: HostSystemPresenceUnavailableReason,
  method: HostPresenceBiometry | null,
): string | null {
  switch (reason) {
    case 'not-supported':
    case 'windows-version':
      return null;
    case 'locked-out':
      return `Too many tries with ${method ? methodName(method) : 'your device’s unlock'}.`;
    case 'addon-unavailable':
      return 'Windows Hello isn’t available.';
    case 'no-device-credential':
    case 'not-enrolled':
    case 'not-configured':
    case 'disabled-by-policy':
      return `${method ? methodName(method) : 'Your device’s unlock'} isn’t available.`;
    default: {
      const unhandled: never = reason;
      void unhandled;
      return 'Your device’s unlock isn’t available.';
    }
  }
}

/** Why "Erase all data on this device" didn't finish, or null once it did. */
export function resetFailure(
  outcome: InstallationResetOutcome,
  appName: string,
): string | null {
  switch (outcome.kind) {
    case 'ready':
      return null;
    case 'transition-in-progress':
      return 'Another account change is still in progress. Try again.';
    case 'uncertain-cleanup':
      return 'Erasing is still running. Try again to check on it.';
    case 'partial-cleanup':
      return outcome.issues.some(
        ({ recovery }) => recovery === 'restart-application',
      )
        ? `${appName} couldn’t erase everything. Restart ${appName}, then try again.`
        : `${appName} couldn’t erase everything on this device. Try again.`;
    default: {
      const unhandled: never = outcome;
      void unhandled;
      return `${appName} couldn’t erase everything on this device. Try again.`;
    }
  }
}
