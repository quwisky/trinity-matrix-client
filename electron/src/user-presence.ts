import type { BrowserWindow, SystemPreferences } from 'electron';

export type SystemPresenceUnavailableReason =
  | 'not-supported'
  | 'not-configured'
  | 'disabled-by-policy'
  | 'windows-version'
  | 'addon-unavailable';

export type SystemPresence =
  | {
      readonly kind: 'available';
      readonly biometry: 'touch-id' | 'windows-hello';
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: SystemPresenceUnavailableReason;
    };

export type PresenceOutcome =
  | { readonly kind: 'verified' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'locked-out' }
  | {
      readonly kind: 'unavailable';
      readonly reason: SystemPresenceUnavailableReason;
    }
  | {
      readonly kind: 'rejected';
      readonly diagnostic: { readonly code: string };
    };

/** The OS prompt that proves the person at the computer is its owner. */
export interface SystemPresenceDriver {
  support(): Promise<SystemPresence>;
  verify(
    reason: string,
    window: BrowserWindow | null,
  ): Promise<PresenceOutcome>;
}

export interface SystemPresenceDeps {
  readonly systemPreferences: Pick<
    SystemPreferences,
    'canPromptTouchID' | 'promptTouchID'
  >;
}

/** The prompt's reason, shown by the OS: 1–120 characters once trimmed. */
export const MAX_PRESENCE_REASON_LENGTH = 120;

export function presenceReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const reason = raw.trim();
  return reason.length > 0 && reason.length <= MAX_PRESENCE_REASON_LENGTH
    ? reason
    : null;
}

/**
 * macOS Touch ID. Electron's prompt evaluates user presence, so the sheet also offers the
 * Mac's password. It rejects for a cancel and for a failed match alike, and macOS throttles
 * failures itself, so a rejection is `cancelled` and never feeds Trinity's delay.
 */
export function touchIdDriver(
  prefs: SystemPresenceDeps['systemPreferences'],
): SystemPresenceDriver {
  return {
    async support() {
      return prefs.canPromptTouchID()
        ? { kind: 'available', biometry: 'touch-id' }
        : { kind: 'unavailable', reason: 'not-supported' };
    },
    async verify(reason) {
      if (!prefs.canPromptTouchID()) {
        return { kind: 'unavailable', reason: 'not-supported' };
      }
      try {
        await prefs.promptTouchID(reason);
        return { kind: 'verified' };
      } catch {
        return { kind: 'cancelled' };
      }
    },
  };
}

/** No system prompt: the Trinity PIN is App lock's only method here (decision 15). */
export const NO_SYSTEM_PRESENCE: SystemPresenceDriver = {
  support: async () => ({ kind: 'unavailable', reason: 'not-supported' }),
  verify: async () => ({ kind: 'unavailable', reason: 'not-supported' }),
};

export function systemPresenceDriver(
  platform: NodeJS.Platform,
  deps: SystemPresenceDeps,
): SystemPresenceDriver {
  return platform === 'darwin'
    ? touchIdDriver(deps.systemPreferences)
    : NO_SYSTEM_PRESENCE;
}
