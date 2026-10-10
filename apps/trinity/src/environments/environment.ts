// This file can be replaced during build by using the `fileReplacements` array.
// The production build replaces `environment.ts` with `environment.prod.ts`.
// The list of file replacements can be found in `apps/trinity/project.json`.

export const environment = {
  production: false,
  // Native push through the Trinity push gateway
  // (https://github.com/quwisky/trinity-push-gateway). `appId` is the base pusher app id
  // (`.ios`/`.android` is appended) and is optional: it defaults to the bundle id
  // (DEFAULT_APP_ID). A fork can set `push` to null to build without native push.
  // Matches PushConfig.
  push: {
    gatewayUrl: 'https://push.trinityproject.dev/_matrix/push/v1/notify',
  } as { gatewayUrl: string; appId?: string } | null,
};
