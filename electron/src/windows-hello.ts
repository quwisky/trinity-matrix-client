import * as path from 'node:path';
import type { BrowserWindow } from 'electron';
import type {
  PresenceOutcome,
  SystemPresence,
  SystemPresenceDriver,
} from './user-presence';

/** The addon built from native/windows-hello; every answer is a stable string. */
export interface WindowsHelloAddon {
  availability(): Promise<string>;
  verify(windowHandle: Buffer, message: string): Promise<string>;
}

/** RequestVerificationForWindowAsync needs Windows 11 (build 22000). */
const FIRST_SUPPORTED_BUILD = 22000;

const PRESENCE_FAILED = {
  kind: 'rejected',
  diagnostic: { code: 'presence-failed' },
} as const;
const PRESENCE_BUSY = {
  kind: 'rejected',
  diagnostic: { code: 'presence-busy' },
} as const;
const NO_WINDOW = {
  kind: 'rejected',
  diagnostic: { code: 'presence-no-window' },
} as const;
const ADDON_UNAVAILABLE = {
  kind: 'unavailable',
  reason: 'addon-unavailable',
} as const;
const WINDOWS_VERSION = {
  kind: 'unavailable',
  reason: 'windows-version',
} as const;

/** The build number of an `os.release()` string ("10.0.22631"), or 0 when unreadable. */
export function windowsBuild(release: string): number {
  const build = Number(release.split('.')[2]);
  return Number.isInteger(build) ? build : 0;
}

function isAddon(value: unknown): value is WindowsHelloAddon {
  return (
    !!value &&
    typeof (value as WindowsHelloAddon).availability === 'function' &&
    typeof (value as WindowsHelloAddon).verify === 'function'
  );
}

/**
 * The packaged addon, or the development build in electron/build. A missing or broken
 * addon is null: no Windows Hello, so App lock uses the Trinity PIN.
 */
export function loadWindowsHello(deps: {
  readonly packaged: boolean;
  readonly resourcesPath: string;
  readonly require: (file: string) => unknown;
}): WindowsHelloAddon | null {
  try {
    const file = deps.packaged
      ? path.join(deps.resourcesPath, 'windows-hello.node')
      : path.join(__dirname, '..', 'build', 'windows-hello.node');
    const addon = deps.require(file);
    return isAddon(addon) ? addon : null;
  } catch {
    return null;
  }
}

function availabilityOf(value: string): SystemPresence {
  switch (value) {
    case 'available':
      return { kind: 'available', biometry: 'windows-hello' };
    case 'disabled-by-policy':
      return { kind: 'unavailable', reason: 'disabled-by-policy' };
    case 'not-configured':
      return { kind: 'unavailable', reason: 'not-configured' };
    default:
      // device-not-present: no Hello on this PC, so the PIN is simply how it unlocks.
      // device-busy and unknown: the PIN this time; support is read again at every unlock.
      return { kind: 'unavailable', reason: 'not-supported' };
  }
}

function outcomeOf(value: string): PresenceOutcome {
  switch (value) {
    case 'verified':
      return { kind: 'verified' };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'retries-exhausted':
      // Hello's own anti-hammering; the lock screen falls back to the PIN.
      return { kind: 'locked-out' };
    case 'not-configured':
    case 'device-not-present':
      // Hello was offered and has gone, so the lock screen names it. Support maps
      // device-not-present to not-supported instead: no Hello on this PC at all.
      return { kind: 'unavailable', reason: 'not-configured' };
    case 'disabled-by-policy':
      return { kind: 'unavailable', reason: 'disabled-by-policy' };
    default:
      return PRESENCE_FAILED;
  }
}

/**
 * Windows Hello through the addon; the Trinity PIN covers everything it cannot.
 *
 * The build is checked first, so Windows 10 reads as `windows-version` and never names Hello.
 *
 * At most one Hello dialog is open at a time: the addon blocks a libuv pool thread (which
 * the PIN's scrypt also needs) for as long as the dialog is open. The renderer already joins
 * or waits for its own prompts; this guard covers a renderer reloaded or recovered from a
 * crash while a dialog is still open. A request for the same reason shares the open dialog
 * and its outcome; a request for another reason is refused with `presence-busy`, so one
 * verification never answers two different questions.
 */
export function windowsHelloDriver(
  addon: WindowsHelloAddon | null,
  build: number,
): SystemPresenceDriver {
  let open: {
    readonly reason: string;
    readonly outcome: Promise<PresenceOutcome>;
  } | null = null;
  /** Hello was available at some support read since main started. */
  let offered = false;

  async function prompt(
    hello: WindowsHelloAddon,
    reason: string,
    window: BrowserWindow,
  ): Promise<PresenceOutcome> {
    try {
      return outcomeOf(
        await hello.verify(window.getNativeWindowHandle(), reason),
      );
    } catch {
      return PRESENCE_FAILED;
    }
  }

  return {
    async support() {
      if (build < FIRST_SUPPORTED_BUILD) return WINDOWS_VERSION;
      if (!addon) return ADDON_UNAVAILABLE;
      let value: string;
      try {
        value = await addon.availability();
      } catch {
        return ADDON_UNAVAILABLE;
      }
      if (value === 'available') offered = true;
      // Hello removed while Trinity runs: a PC whose only Hello method was its Hello PIN may
      // then report no device. Once Hello was offered, name it rather than read the PC as
      // PIN-only. Main keeps this across renderer reloads; a restart forgets it.
      if (value === 'device-not-present' && offered) {
        return { kind: 'unavailable', reason: 'not-configured' };
      }
      return availabilityOf(value);
    },
    async verify(reason, window) {
      if (build < FIRST_SUPPORTED_BUILD) return WINDOWS_VERSION;
      if (!addon) return ADDON_UNAVAILABLE;
      if (!window) return NO_WINDOW;
      if (open) return open.reason === reason ? open.outcome : PRESENCE_BUSY;
      const outcome = prompt(addon, reason, window).finally(() => {
        open = null;
      });
      open = { reason, outcome };
      return outcome;
    },
  };
}
