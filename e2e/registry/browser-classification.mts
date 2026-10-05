export const BROWSER_CAPABILITIES = [
  'accounts',
  'workspace',
  'room-library',
  'room-administration',
  'conversations',
  'trust',
  'identity',
  'notifications',
  'discovery-search',
  'settings',
  'host-shell',
] as const;

export type BrowserCapability = (typeof BROWSER_CAPABILITIES)[number];
