import {
  devices,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import { testResourceId } from './support/namespace.mts';

import { test } from './web-fixtures.mts';

export { test };
export { devices, expect, testResourceId };
export type { APIRequestContext, Locator, Page, Route };
