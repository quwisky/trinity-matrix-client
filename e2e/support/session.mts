import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { processIsAlive } from './process-lock.mts';

export const E2E_SESSION_ENV = 'TRINITY_E2E_SESSION_FILE';
export const E2E_SESSION_VERSION = 1;

export interface SynapseSessionDescriptor {
  readonly available: boolean;
  readonly hs?: string;
  readonly user?: string;
  readonly pass?: string;
  readonly secondary?: {
    readonly hs: string;
    readonly serverName: string;
    readonly registrationSecret: string;
  };
  readonly sso?: {
    readonly user: string;
    readonly email: string;
    readonly pass: string;
  };
  readonly ssoReset?: {
    readonly user: string;
    readonly email: string;
    readonly pass: string;
  };
}

export interface E2ESessionDescriptor {
  readonly version: typeof E2E_SESSION_VERSION;
  readonly id: string;
  readonly workspaceRoot: string;
  readonly owner: {
    readonly pid: number;
    readonly nonce: string;
    readonly createdAt: string;
  };
  readonly resources: readonly string[];
  readonly endpoints: {
    readonly application: string;
    readonly storybook: string;
    readonly report: string;
  };
  readonly artifactsRoot: string;
  readonly synapse?: SynapseSessionDescriptor;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLoopbackOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      Boolean(url.port) &&
      url.pathname === '/'
    );
  } catch {
    return false;
  }
}

function assertSynapse(
  value: unknown,
): asserts value is SynapseSessionDescriptor {
  if (!isObject(value) || typeof value['available'] !== 'boolean') {
    throw new Error('E2E session has an invalid Synapse capability');
  }
  if (value['available']) {
    for (const key of ['hs', 'user', 'pass'] as const) {
      if (typeof value[key] !== 'string' || value[key].length === 0) {
        throw new Error(`E2E session is missing required Synapse field ${key}`);
      }
    }
  }
}

export function validateSession(value: unknown): E2ESessionDescriptor {
  if (!isObject(value) || value['version'] !== E2E_SESSION_VERSION) {
    throw new Error(`Unsupported E2E session descriptor version`);
  }
  const owner = value['owner'];
  const endpoints = value['endpoints'];
  if (
    typeof value['id'] !== 'string' ||
    !/^[a-z0-9-]{8,80}$/.test(value['id']) ||
    typeof value['workspaceRoot'] !== 'string' ||
    !isObject(owner) ||
    !Number.isInteger(owner['pid']) ||
    Number(owner['pid']) <= 0 ||
    typeof owner['nonce'] !== 'string' ||
    owner['nonce'].length < 8 ||
    typeof owner['createdAt'] !== 'string' ||
    !Array.isArray(value['resources']) ||
    value['resources'].some((resource) => typeof resource !== 'string') ||
    new Set(value['resources']).size !== value['resources'].length ||
    !isObject(endpoints) ||
    !isLoopbackOrigin(endpoints['application']) ||
    !isLoopbackOrigin(endpoints['storybook']) ||
    !isLoopbackOrigin(endpoints['report']) ||
    typeof value['artifactsRoot'] !== 'string'
  ) {
    throw new Error('E2E session descriptor failed structural validation');
  }
  if (value['synapse'] !== undefined) assertSynapse(value['synapse']);
  return value as unknown as E2ESessionDescriptor;
}

export function writeSession(
  file: string,
  descriptor: E2ESessionDescriptor,
): void {
  validateSession(descriptor);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(descriptor, undefined, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, file);
}

export function readSession(
  file = process.env[E2E_SESSION_ENV],
  options: { readonly requireLiveOwner?: boolean } = {},
): E2ESessionDescriptor {
  if (!file) throw new Error(`${E2E_SESSION_ENV} is not set`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read E2E session descriptor at ${file}`, {
      cause: error,
    });
  }
  const descriptor = validateSession(parsed);
  if (
    options.requireLiveOwner !== false &&
    !processIsAlive(descriptor.owner.pid)
  ) {
    throw new Error(
      `E2E session ${descriptor.id} has no live owner (PID ${descriptor.owner.pid})`,
    );
  }
  return descriptor;
}

export function removeSession(file: string): void {
  rmSync(file, { force: true });
}

/** Explicitly remove a validated descriptor whose owning process is dead. */
export function recoverStaleSession(file: string): boolean {
  let observed: string;
  try {
    observed = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  let descriptor: E2ESessionDescriptor;
  try {
    descriptor = validateSession(JSON.parse(observed));
  } catch (error) {
    throw new Error(`Refusing to recover an invalid E2E session at ${file}`, {
      cause: error,
    });
  }
  if (processIsAlive(descriptor.owner.pid)) {
    throw new Error(`Refusing to recover a live E2E session at ${file}`);
  }
  const quarantine = `${file}.stale-${process.pid}-${randomUUID()}`;
  renameSync(file, quarantine);
  if (readFileSync(quarantine, 'utf8') !== observed) {
    renameSync(quarantine, file);
    throw new Error(`E2E session at ${file} changed during stale recovery`);
  }
  rmSync(quarantine, { force: true });
  return true;
}

export function sessionFileFor(workspaceRoot: string, id: string): string {
  return join(
    resolve(workspaceRoot),
    'dist/.playwright/sessions',
    `${id}.json`,
  );
}

export function sessionEnvironment(
  descriptor: E2ESessionDescriptor,
  file: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    [E2E_SESSION_ENV]: file,
    BASE_URL: descriptor.endpoints.application,
    TRINITY_E2E_APP_URL: descriptor.endpoints.application,
    TRINITY_E2E_STORYBOOK_URL: descriptor.endpoints.storybook,
    TRINITY_E2E_REPORT_URL: descriptor.endpoints.report,
  };
  if (descriptor.synapse?.available) {
    environment['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    environment['TRINITY_HS'] = descriptor.synapse.hs;
    environment['TRINITY_USER'] = descriptor.synapse.user;
    environment['TRINITY_PASS'] = descriptor.synapse.pass;
  }
  return environment;
}

/** A diagnostic that intentionally never includes credentials. */
export function sessionSummary(descriptor: E2ESessionDescriptor): string {
  return [
    `id=${descriptor.id}`,
    `owner=${descriptor.owner.pid}`,
    `resources=${descriptor.resources.join(',') || 'none'}`,
    `app=${descriptor.endpoints.application}`,
    `synapse=${descriptor.synapse?.available ? 'available' : 'not-requested'}`,
  ].join(' ');
}

/** Resolve the app endpoint only through a validated, live invocation descriptor. */
export function applicationOrigin(): string {
  return readSession().endpoints.application;
}

/** Stable unique id for one non-Playwright driver within an invocation. */
export function invocationResourceId(purpose: string): string {
  const descriptor = readSession();
  const digest = createHash('sha256')
    .update(`${descriptor.id}:${purpose}`)
    .digest('hex')
    .slice(0, 12);
  return `${purpose
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 20)}-${digest}`;
}
