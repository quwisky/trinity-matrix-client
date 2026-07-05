// Pure Matrix models/helpers now live in @trinity/util-matrix, and native platform
// capabilities in @trinity/platform-native; re-exported here so existing
// `@trinity/core` consumers are unaffected during the lib restructure.
export * from '@trinity/util-matrix';
export * from '@trinity/platform-native';
export * from './lib/matrix/matrix-client.service';
export * from './lib/matrix/rooms.service';
export * from './lib/matrix/spaces.service';
export * from './lib/matrix/invites.service';
export * from './lib/matrix/search.service';
export * from './lib/matrix/timeline.service';
export * from './lib/matrix/threads.service';
export * from './lib/matrix/pinned-messages.service';
export * from './lib/matrix/media.service';
export * from './lib/matrix/avatar.service';
export * from './lib/matrix/auth.service';
export * from './lib/matrix/profile.service';
export * from './lib/matrix/devices.service';
export * from './lib/matrix/push.service';
export * from './lib/matrix/notification.service';
export * from './lib/matrix/crypto-spike.service';
export * from './lib/matrix/secret-storage-key.service';
export * from './lib/matrix/crypto.service';
export * from './lib/matrix/verification.service';
export * from './lib/platform/app-badge.service';
export * from './lib/guards/auth.guard';
