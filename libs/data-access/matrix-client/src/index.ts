export * from './lib/matrix-client.service';
// Consumers of `syncState` need its type, and feature libs are barred from importing
// matrix-js-sdk — so surface it here rather than leave them deriving it from the signal.
export type { SyncState } from 'matrix-js-sdk';
export * from './lib/secret-storage-key-holder';
export * from './lib/reproject-on-switch';
export * from './lib/coalesce';
export * from './lib/project-from-client';
