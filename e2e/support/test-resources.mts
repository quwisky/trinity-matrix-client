import { createHash } from 'node:crypto';
import type { TestResourceNamespace } from './namespace.mts';

function matrixLocalpart(
  namespace: TestResourceNamespace,
  purpose: string,
): string {
  const role = purpose
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 20);
  const digest = createHash('sha256')
    .update(namespace.role(purpose))
    .digest('hex')
    .slice(0, 12);
  return `trn_${role || 'resource'}_${digest}`;
}

/** Names every server-side resource through one per-attempt namespace. */
export class MatrixTestResources {
  readonly namespace: TestResourceNamespace;

  constructor(namespace: TestResourceNamespace) {
    this.namespace = namespace;
  }

  userLocalpart(role: string): string {
    return matrixLocalpart(this.namespace, role);
  }

  roomName(purpose: string): string {
    return `Trinity ${this.namespace.role(purpose)}`;
  }

  aliasLocalpart(purpose: string): string {
    return matrixLocalpart(this.namespace, purpose).replaceAll('_', '-');
  }

  cleanup(label: string, operation: () => Promise<void>): void {
    this.namespace.registerCleanup(label, operation);
  }
}
