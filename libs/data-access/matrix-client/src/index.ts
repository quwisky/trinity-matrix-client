export * from './lib/js-sdk/matrix-client.service';
export * from './lib/matrix-sdk-logging';
// Consumers of `syncState` need its type, and feature libs are barred from importing
// matrix-js-sdk — so surface it here rather than leave them deriving it from the signal.
export type { SyncState } from 'matrix-js-sdk';
export * from './lib/secret-storage-key-holder';
export * from './lib/reproject-on-switch';
export * from './lib/coalesce';
export * from './lib/project-from-client';
export * from './lib/trust-crypto.port';
export * from './lib/identity-matrix.port';
export * from './lib/known-names';
export * from './lib/session-engine';
export * from './lib/session-engine.token';
export * from './lib/server-support';
export * from './lib/mutual-rooms';
export * from './lib/js-sdk/js-sdk-clients';
