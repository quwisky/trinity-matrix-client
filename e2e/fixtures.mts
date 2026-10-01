import {
  devices,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import { testResourceId } from './support/namespace.mts';

export { test } from './web-fixtures.mts';
export { devices, expect, testResourceId };
export type { APIRequestContext, Locator, Page, Route };
