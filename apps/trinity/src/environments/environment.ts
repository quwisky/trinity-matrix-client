import { DEFAULT_PUSH_GATEWAY_URL } from '@trinity/util/push-client';

export const environment = {
  production: false,
  // Replace the shared DEFAULT_PUSH_GATEWAY_URL for a deployed Trinity gateway.
  // The shipped .invalid placeholder cannot deliver notifications. A saved device
  // override takes precedence; platform credentials belong in native/gateway setup.
  push: { gatewayUrl: DEFAULT_PUSH_GATEWAY_URL },
};
