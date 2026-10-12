import {
  getTrinityDesktopBridge,
  isElectronRenderer,
  isInstalledNativePlatform,
  isNativeIos,
} from '@trinity/platform-native';

/** What the platform line is built from; read once, described purely. */
export interface PlatformFacts {
  readonly host: 'web' | 'desktop' | 'ios' | 'android';
  readonly userAgent: string;
  /** The Electron bridge's `process.platform`, on desktop only. */
  readonly desktopPlatform: string | null;
}

const DESKTOP_OS: Readonly<Record<string, string>> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

/** The host Trinity is running in, from the same predicates the rest of the app uses. */
export function readPlatformFacts(): PlatformFacts {
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (isElectronRenderer()) {
    return {
      host: 'desktop',
      userAgent,
      desktopPlatform: getTrinityDesktopBridge()?.platform ?? null,
    };
  }
  if (isInstalledNativePlatform()) {
    return {
      host: isNativeIos() ? 'ios' : 'android',
      userAgent,
      desktopPlatform: null,
    };
  }
  return { host: 'web', userAgent, desktopPlatform: null };
}

/** One line for the log header and the issue's Environment field. */
export function describePlatform(facts: PlatformFacts): string {
  switch (facts.host) {
    case 'desktop': {
      const electron = /Electron\/(\d+(?:\.\d+)*)/.exec(facts.userAgent)?.[1];
      const os =
        (facts.desktopPlatform && DESKTOP_OS[facts.desktopPlatform]) ??
        facts.desktopPlatform ??
        osOf(facts.userAgent);
      return `Desktop (Electron${electron ? ` ${electron}` : ''}), ${os}`;
    }
    case 'ios':
      return `iOS app, ${osOf(facts.userAgent)}`;
    case 'android':
      return `Android app, ${osOf(facts.userAgent)}`;
    case 'web':
      return `Web, ${browserOf(facts.userAgent)} on ${osOf(facts.userAgent)}`;
  }
}

function browserOf(userAgent: string): string {
  const rules: readonly (readonly [RegExp, string])[] = [
    [/Edg\/(\d+)/, 'Edge'],
    [/Firefox\/(\d+)/, 'Firefox'],
    [/Chrome\/(\d+)/, 'Chrome'],
    [/Version\/(\d+(?:\.\d+)?).*Safari\//, 'Safari'],
  ];
  for (const [pattern, name] of rules) {
    const version = pattern.exec(userAgent)?.[1];
    if (version) {
      return `${name} ${version}`;
    }
  }
  return 'unknown browser';
}

function osOf(userAgent: string): string {
  const ios = /(?:iPhone|iPad|iPod).*? OS (\d+(?:_\d+)*)/.exec(userAgent)?.[1];
  if (ios) {
    return `iOS ${ios.replace(/_/g, '.')}`;
  }
  const android = /Android (\d+(?:\.\d+)*)/.exec(userAgent)?.[1];
  if (android) {
    return `Android ${android}`;
  }
  if (/Windows NT/.test(userAgent)) return 'Windows';
  if (/CrOS/.test(userAgent)) return 'ChromeOS';
  if (/Mac OS X|Macintosh/.test(userAgent)) return 'macOS';
  if (/Linux/.test(userAgent)) return 'Linux';
  return 'unknown OS';
}
