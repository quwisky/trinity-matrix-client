export const environment = {
  production: true,
  // See environment.ts. Set `gatewayUrl` to enable native push in production builds;
  // `appId` is optional (defaults to the bundle id).
  push: null as { gatewayUrl: string; appId?: string } | null,
};
