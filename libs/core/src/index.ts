// Pure Matrix models/helpers now live in @trinity/util-matrix, and native platform
// capabilities in @trinity/platform-native; re-exported here so existing
// `@trinity/core` consumers are unaffected during the lib restructure.
export * from '@trinity/util-matrix';
export * from '@trinity/platform-native';
export * from '@trinity/data-access-matrix-client';
export * from '@trinity/data-access-auth';
export * from '@trinity/data-access-notifications';
export * from '@trinity/data-access-search';
export * from '@trinity/data-access-pinned';
export * from '@trinity/data-access-invites';
export * from '@trinity/data-access-profile';
export * from '@trinity/data-access-crypto';
export * from '@trinity/data-access-timeline';
export * from '@trinity/data-access-rooms';
export * from '@trinity/data-access-media';
export * from './lib/platform/app-badge.service';
