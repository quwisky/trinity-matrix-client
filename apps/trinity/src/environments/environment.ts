// This file can be replaced during build by using the `fileReplacements` array.
// The production build replaces `environment.ts` with `environment.prod.ts`.
// The list of file replacements can be found in `apps/trinity/project.json`.

export const environment = {
  production: false,
  // Native push notifications. Set both fields to enable (needs a deployed Sygnal
  // push gateway + FCM/APNs credentials); null leaves push disabled (the app falls
  // back to in-app/sync updates). `appId` is the base id; `.ios`/`.android` is appended.
  push: null as { gatewayUrl: string; appId: string } | null,
};
