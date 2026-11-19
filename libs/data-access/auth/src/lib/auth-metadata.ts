// The validated delegated-auth metadata, so feature libs can type it without importing
// matrix-js-sdk directly (components never do). Aliased to a local name so an upstream rename
// only touches this line.
export type { ValidatedAuthMetadata as AuthMetadata } from 'matrix-js-sdk';
