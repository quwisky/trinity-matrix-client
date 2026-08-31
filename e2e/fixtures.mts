import {
  devices,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import { testResourceId } from './support/namespace.mts';
import { resourceFixtureDefinitions } from './support/resource-fixtures.mts';

/**
 * Composition-edge fixture selection. Environment adapters depend inward on shared
 * contracts; only this entrypoint chooses one adapter for the current invocation.
 */
const adapter =
  process.env['TRINITY_E2E_PLATFORM'] === 'android'
    ? await import('./android/fixtures.mts')
    : await import('./web-fixtures.mts');

const environmentTest =
  adapter.test as typeof import('./android/fixtures.mts').test;

export const test = environmentTest.extend(resourceFixtureDefinitions);
export { devices, expect, testResourceId };
export type { APIRequestContext, Locator, Page, Route };
