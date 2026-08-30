import { ipcMain } from 'electron';
import { getMainWindow } from './window';

export const HOST_PROTOCOL_VERSION = 1;
export const HOST_NEGOTIATE_CHANNEL = 'trinity:host:v1:negotiate';

export const HOST_OPERATIONS = [
  'authentication-handoff',
  'deep-links',
  'back',
  'file-export',
  'notification-presentation',
  'location',
  'badge',
  'secure-store',
  'lifecycle',
  'updates',
] as const;

type HostOperation = (typeof HOST_OPERATIONS)[number];
type Support =
  | { readonly kind: 'supported' }
  | { readonly kind: 'unavailable'; readonly reason: 'not-implemented' };

const SUPPORTED = new Set<HostOperation>([
  'authentication-handoff',
  'deep-links',
  'file-export',
  'notification-presentation',
  'location',
  'badge',
  'secure-store',
  'lifecycle',
]);

function isOperation(value: unknown): value is HostOperation {
  return (
    typeof value === 'string' &&
    (HOST_OPERATIONS as readonly string[]).includes(value)
  );
}

export function negotiateHostCapabilities(raw: unknown):
  | {
      readonly kind: 'accepted';
      readonly protocolVersion: 1;
      readonly operations: Readonly<Record<HostOperation, Support>>;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: 'protocol-mismatch' | 'malformed-request';
    } {
  if (!raw || typeof raw !== 'object') {
    return { kind: 'rejected', reason: 'malformed-request' };
  }
  const request = raw as {
    readonly protocolVersion?: unknown;
    readonly operations?: unknown;
  };
  if (request.protocolVersion !== HOST_PROTOCOL_VERSION) {
    return { kind: 'rejected', reason: 'protocol-mismatch' };
  }
  if (
    !Array.isArray(request.operations) ||
    request.operations.length > HOST_OPERATIONS.length ||
    new Set(request.operations).size !== request.operations.length ||
    !request.operations.every(isOperation)
  ) {
    return { kind: 'rejected', reason: 'malformed-request' };
  }
  const requested = new Set(request.operations);
  const support = (operation: HostOperation): Support =>
    requested.has(operation) && SUPPORTED.has(operation)
      ? { kind: 'supported' }
      : { kind: 'unavailable', reason: 'not-implemented' };
  const operations: Record<HostOperation, Support> = {
    'authentication-handoff': support('authentication-handoff'),
    'deep-links': support('deep-links'),
    back: support('back'),
    'file-export': support('file-export'),
    'notification-presentation': support('notification-presentation'),
    location: support('location'),
    badge: support('badge'),
    'secure-store': support('secure-store'),
    lifecycle: support('lifecycle'),
    updates: support('updates'),
  };
  return { kind: 'accepted', protocolVersion: 1, operations };
}

/** Install the versioned renderer-to-main negotiation with strict sender validation. */
export function registerHostCapabilityHandshake(): void {
  ipcMain.handle(HOST_NEGOTIATE_CHANNEL, (event, raw: unknown) => {
    const win = getMainWindow();
    if (!win || event.sender !== win.webContents) {
      return { kind: 'rejected', reason: 'malformed-request' } as const;
    }
    return negotiateHostCapabilities(raw);
  });
}
