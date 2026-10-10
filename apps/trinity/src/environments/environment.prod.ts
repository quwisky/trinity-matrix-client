export const environment = {
  production: true,
  // See environment.ts.
  push: {
    gatewayUrl: 'https://push.trinityproject.dev/_matrix/push/v1/notify',
  } as { gatewayUrl: string; appId?: string } | null,
};
