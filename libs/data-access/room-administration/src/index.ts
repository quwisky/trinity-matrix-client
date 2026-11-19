// Only `export *` here: with `sideEffects: false` in ../package.json, esbuild then keeps the
// files the startup bundle doesn't use (room settings, upgrade, moderation…) in lazy chunks.
// One named re-export makes every file below part of the startup bundle again.
export * from './lib/room-action-permissions.service';
export * from './lib/room-administration-error';
export * from './lib/room-administration-lifetime';
export * from './lib/room-administration-health.models';
export * from './lib/room-members.service';
export * from './lib/room-member-role';
export * from './lib/room-settings.service';
export * from './lib/room-moderation.service';
export * from './lib/room-aliases.service';
export * from './lib/room-message-governance.service';
export * from './lib/room-pin-governance.service';
export * from './lib/room-advanced-info';
export * from './lib/room-upgrade.service';
export * from './lib/content-reporting.service';
export * from './lib/room-encryption.service';
export * from './lib/room-directory.service';
export * from './lib/room-permission-rows';
export * from './lib/room-permissions.service';
