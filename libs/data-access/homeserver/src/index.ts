// @trinity/data-access/homeserver — what each account's homeserver says it is running.
//
// Trinity-owned types only: feature libs may not import matrix-js-sdk, so an SDK type
// crossing this barrel would be a boundary leak (see homeserver-info.model.ts).
export * from './lib/homeserver-info.model';
export * from './lib/homeserver-info.service';
export * from './lib/room-version-status';
export * from './lib/homeserver-engine';
export { JsSdkHomeserverEngine } from './lib/js-sdk/js-sdk-homeserver-engine';
