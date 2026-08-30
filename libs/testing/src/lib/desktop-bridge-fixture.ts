/** Test-only structural mirror of the protocol-v1 Electron preload bridge. */
export interface DesktopBridgeFixture {
  readonly protocolVersion: 1;
  readonly isElectron: true;
  readonly platform: string;
  readonly negotiate: (operations: readonly string[]) => Promise<unknown>;
  readonly capabilities: {
    readonly deepLinks: {
      readonly subscribe: (callback: (url: string) => void) => () => void;
    };
    readonly notificationPresentation: {
      readonly present: (payload: unknown) => void;
      readonly subscribeClicks: (
        callback: (roomId: string, userId?: string) => void,
      ) => () => void;
    };
    readonly badge: {
      readonly set: (count: number) => Promise<
        | { readonly kind: 'completed' }
        | {
            readonly kind: 'unavailable';
            readonly reason:
              | 'not-implemented'
              | 'not-supported'
              | 'protocol-mismatch'
              | 'host-rejected';
          }
        | { readonly kind: 'rejected'; readonly diagnostic: { code: string } }
      >;
    };
    readonly secureStore: {
      readonly isAvailable: () => Promise<boolean>;
      readonly get: (key: string) => Promise<string | null>;
      readonly set: (key: string, value: string) => Promise<boolean>;
      readonly delete: (key: string) => Promise<void>;
    };
    readonly networkCors: {
      readonly setAllowedOrigins: (origins: readonly string[]) => void;
      readonly allowOrigin: (origin: string) => void;
    };
    readonly location: {
      readonly approximate: () => Promise<{
        lat: number;
        lng: number;
      } | null>;
    };
  };
}

type CapabilityOverrides = {
  readonly [K in keyof DesktopBridgeFixture['capabilities']]?: Partial<
    DesktopBridgeFixture['capabilities'][K]
  >;
};

export type DesktopBridgeFixtureOverrides = Omit<
  Partial<DesktopBridgeFixture>,
  'capabilities'
> & {
  readonly capabilities?: CapabilityOverrides;
};

/**
 * Build one complete, valid bridge with narrow nested overrides. Protocol evolution
 * therefore changes one fixture instead of forcing unrelated suites to paste partial
 * globals that the production guard would correctly reject.
 */
export function desktopBridgeFixture(
  overrides: DesktopBridgeFixtureOverrides = {},
): DesktopBridgeFixture {
  const defaults: DesktopBridgeFixture = {
    protocolVersion: 1,
    isElectron: true,
    platform: 'linux',
    negotiate: async () => ({ kind: 'rejected', reason: 'host-rejected' }),
    capabilities: {
      deepLinks: { subscribe: () => () => undefined },
      notificationPresentation: {
        present: () => undefined,
        subscribeClicks: () => () => undefined,
      },
      badge: {
        set: async () => ({ kind: 'completed' }),
      },
      secureStore: {
        isAvailable: async () => false,
        get: async () => null,
        set: async () => false,
        delete: async () => undefined,
      },
      networkCors: {
        setAllowedOrigins: () => undefined,
        allowOrigin: () => undefined,
      },
      location: { approximate: async () => null },
    },
  };
  const capabilities = overrides.capabilities;
  return {
    ...defaults,
    ...overrides,
    capabilities: {
      deepLinks: {
        ...defaults.capabilities.deepLinks,
        ...capabilities?.deepLinks,
      },
      notificationPresentation: {
        ...defaults.capabilities.notificationPresentation,
        ...capabilities?.notificationPresentation,
      },
      badge: { ...defaults.capabilities.badge, ...capabilities?.badge },
      secureStore: {
        ...defaults.capabilities.secureStore,
        ...capabilities?.secureStore,
      },
      networkCors: {
        ...defaults.capabilities.networkCors,
        ...capabilities?.networkCors,
      },
      location: {
        ...defaults.capabilities.location,
        ...capabilities?.location,
      },
    },
  };
}
