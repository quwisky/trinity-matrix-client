import { E2E_TIMEOUTS_MS, registeredE2ESuite } from '../registry/index.mts';
import type { E2ESuiteDefinition } from '../support/e2e-registry.types.mts';

export const PROTOCOL_SUITE_ENV = 'TRINITY_E2E_PROTOCOL_SUITE';
export const PROTOCOL_MODE_ENV = 'TRINITY_E2E_PROTOCOL_MODE';

export const PROTOCOL_CASES = {
  'protocol.verify-sas': {
    spec: 'verify-sas.spec.mjs',
    browserName: 'chromium',
    remoteMutation: true,
    secondaryAccount: false,
  },
  'protocol.verify-qr': {
    spec: 'verify-qr.spec.mjs',
    browserName: 'chromium',
    remoteMutation: true,
    secondaryAccount: false,
  },
  'protocol.media': {
    spec: 'send-media.spec.mjs',
    browserName: 'chromium',
    remoteMutation: true,
    secondaryAccount: false,
  },
  'protocol.threads': {
    spec: 'threads.spec.mjs',
    browserName: 'chromium',
    remoteMutation: true,
    secondaryAccount: false,
  },
  'protocol.reply': {
    spec: 'reply.spec.mjs',
    browserName: 'chromium',
    remoteMutation: true,
    secondaryAccount: false,
  },
  'protocol.spaces': {
    spec: 'spaces.spec.mjs',
    browserName: 'chromium',
    remoteMutation: true,
    secondaryAccount: false,
  },
  'protocol.rooms': {
    spec: 'rooms.spec.mjs',
    browserName: 'chromium',
    remoteMutation: true,
    secondaryAccount: true,
  },
  'protocol.search': {
    spec: 'search.spec.mjs',
    browserName: 'chromium',
    remoteMutation: true,
    secondaryAccount: true,
  },
  'protocol.emoji': {
    spec: 'emoji.spec.mjs',
    browserName: 'chromium',
    remoteMutation: true,
    secondaryAccount: false,
  },
  'protocol.verify-sas-selfcheck': {
    spec: 'verify-sas-selfcheck.spec.mjs',
    browserName: 'chromium',
    remoteMutation: false,
    secondaryAccount: false,
  },
  'protocol.crypto-spike-chromium': {
    spec: 'crypto-spike.spec.mjs',
    browserName: 'chromium',
    remoteMutation: false,
    secondaryAccount: false,
  },
  'protocol.crypto-spike-webkit': {
    spec: 'crypto-spike.spec.mjs',
    browserName: 'webkit',
    remoteMutation: false,
    secondaryAccount: false,
  },
  'protocol.login-smoke': {
    spec: 'smoke-login.spec.mjs',
    browserName: 'chromium',
    remoteMutation: false,
    secondaryAccount: false,
  },
} as const satisfies Record<
  string,
  {
    readonly spec: string;
    readonly browserName: 'chromium' | 'webkit';
    readonly remoteMutation: boolean;
    readonly secondaryAccount: boolean;
  }
>;

export type ProtocolSuiteId = keyof typeof PROTOCOL_CASES;
export type ProtocolMode = 'disposable' | 'remote';

export interface ProtocolCredentials {
  readonly mode: ProtocolMode;
  readonly hs: string;
  readonly user: string;
  readonly pass: string;
  readonly secondary?: {
    readonly user: string;
    readonly pass: string;
  };
}

export function isProtocolSuiteId(value: string): value is ProtocolSuiteId {
  return Object.hasOwn(PROTOCOL_CASES, value);
}

export function protocolCase(id: ProtocolSuiteId) {
  return PROTOCOL_CASES[id];
}

export function protocolSuite(id: ProtocolSuiteId): E2ESuiteDefinition {
  return registeredE2ESuite(id);
}

export function selectedProtocolSuiteId(
  environment: NodeJS.ProcessEnv = process.env,
): ProtocolSuiteId {
  const value = environment[PROTOCOL_SUITE_ENV];
  if (!value || !isProtocolSuiteId(value)) {
    throw new Error(
      `${PROTOCOL_SUITE_ENV} must name one registered protocol suite`,
    );
  }
  return value;
}

export function protocolMode(
  environment: NodeJS.ProcessEnv = process.env,
): ProtocolMode {
  const value = environment[PROTOCOL_MODE_ENV] ?? 'disposable';
  if (value !== 'disposable' && value !== 'remote') {
    throw new Error(`${PROTOCOL_MODE_ENV} must be either disposable or remote`);
  }
  return value;
}

function requiredSecret(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`Remote protocol mode requires ${name}`);
  return value;
}

export function remoteProtocolCredentials(
  id: ProtocolSuiteId,
  environment: NodeJS.ProcessEnv = process.env,
): ProtocolCredentials {
  const definition = protocolCase(id);
  if (!definition.remoteMutation) {
    throw new Error(`${id} does not support remote mutation mode`);
  }
  const hs = requiredSecret(environment, 'TRINITY_HS');
  let homeserver: URL;
  try {
    homeserver = new URL(hs);
  } catch {
    throw new Error('TRINITY_HS must be an absolute HTTPS URL');
  }
  if (
    homeserver.protocol !== 'https:' ||
    homeserver.username ||
    homeserver.password
  ) {
    throw new Error(
      'TRINITY_HS must be an absolute HTTPS URL without embedded credentials',
    );
  }
  if (environment['NODE_TLS_REJECT_UNAUTHORIZED'] === '0') {
    throw new Error(
      'Remote protocol mode requires TLS certificate verification',
    );
  }
  const user = requiredSecret(environment, 'TRINITY_USER');
  const pass = requiredSecret(environment, 'TRINITY_PASS');
  const secondary = definition.secondaryAccount
    ? {
        user: requiredSecret(environment, 'TRINITY_SECONDARY_USER'),
        pass: requiredSecret(environment, 'TRINITY_SECONDARY_PASS'),
      }
    : undefined;
  return {
    mode: 'remote',
    hs: homeserver.href.replace(/\/$/u, ''),
    user,
    pass,
    secondary,
  };
}

export function protocolResources(
  id: ProtocolSuiteId,
  mode: ProtocolMode,
  environment: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const suite = protocolSuite(id);
  if (mode === 'remote') {
    remoteProtocolCredentials(id, environment);
    return suite.serializationKeys.filter((key) => key !== 'synapse');
  }
  return suite.serializationKeys;
}

export function protocolTimeout(id: ProtocolSuiteId): number {
  return E2E_TIMEOUTS_MS[protocolSuite(id).timeoutClass];
}

export function protocolTracePolicy(
  mode: ProtocolMode,
  ci: boolean,
): 'off' | 'on-first-retry' | 'retain-on-failure' {
  if (mode === 'remote') return 'off';
  return ci ? 'on-first-retry' : 'retain-on-failure';
}
