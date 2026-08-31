import { resolve } from 'node:path';
import { runFeature } from './run-feature.mts';

const COMPATIBILITY_FEATURES = new Set([
  'emoji',
  'reply',
  'rooms',
  'search',
  'send-media',
  'spaces',
  'threads',
  'verify-qr',
  'verify-sas',
]);

/** Shared owner behind the nine stable `e2e/runners/*-run.mjs` entrypoints. */
export async function runProtocolCompatibility(
  feature: string,
  workspaceRoot = resolve(import.meta.dirname, '../..'),
): Promise<number> {
  if (!COMPATIBILITY_FEATURES.has(feature)) {
    throw new Error(`Unknown protocol compatibility feature: ${feature}`);
  }
  return runFeature(
    [`--feature=${feature}`, '--resource=synapse'],
    workspaceRoot,
  );
}
