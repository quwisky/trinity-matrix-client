import type { E2EContractType } from '../support/e2e-registry.types.mts';

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

export const BROWSER_CONTRACT_TYPES = [
  'accessibility',
  'host',
  'journey',
  'security',
  'visual',
] as const satisfies readonly Exclude<E2EContractType, 'protocol'>[];

export type BrowserContractType = (typeof BROWSER_CONTRACT_TYPES)[number];
