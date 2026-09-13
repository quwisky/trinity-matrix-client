import type {
  AccountElement,
  AccountElementFilter,
  AccountWorkspaceClient,
} from './account-workspace-client.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';
import type { SpaceSettingsCoreAssertion } from './space-settings-core-contract.mts';

export const visibleOne = (elements: readonly AccountElement[]): boolean =>
  elements.length === 1 && elements[0]!.visible;

export const absent = (elements: readonly AccountElement[]): boolean =>
  elements.length === 0;

export function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

/** Poll only finite reads; retain the last observation even if polling fails. */
async function observedValue<T>(
  client: AccountWorkspaceClient,
  assertionIdentity: SpaceSettingsCoreAssertion,
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  let observation: T | null = null;
  let value: T;
  try {
    value = await waitForNativeShellState(
      async () => {
        const latest = await read();
        observation = latest;
        return latest;
      },
      accepts,
      assertionIdentity,
      client.signal,
      timeoutMs,
    );
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await client.record(assertionIdentity, {
        assertion: assertionIdentity,
        observation,
        error: describeFailure(error),
      });
    } catch (diagnosticError) {
      failures.push(diagnosticError);
    }
    throw new AggregateError(
      failures,
      `${assertionIdentity}: ${describeFailure(error)}`,
    );
  }
  await client.record(assertionIdentity, {
    assertion: assertionIdentity,
    observation: value,
  });
  return value;
}

export function observedElements(
  client: AccountWorkspaceClient,
  assertionIdentity: SpaceSettingsCoreAssertion,
  selector: string,
  accepts: (elements: readonly AccountElement[]) => boolean,
  filter: AccountElementFilter = {},
  timeoutMs = 30_000,
): Promise<readonly AccountElement[]> {
  return observedValue(
    client,
    assertionIdentity,
    () => client.elements(selector, filter),
    accepts,
    timeoutMs,
  );
}

/** The expression must only inspect the WebView; actions belong to native input. */
export function observedExpression(
  client: AccountWorkspaceClient,
  assertionIdentity: SpaceSettingsCoreAssertion,
  expression: string,
  accepts: (value: unknown) => boolean,
  timeoutMs = 30_000,
): Promise<unknown> {
  return observedValue(
    client,
    assertionIdentity,
    () => evaluateNative(client.webview, expression),
    accepts,
    timeoutMs,
  );
}

/** Use finite Matrix GETs here; never put a fixture write in a polling callback. */
export function observedServerValue<T>(
  client: AccountWorkspaceClient,
  assertionIdentity: SpaceSettingsCoreAssertion,
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  return observedValue(client, assertionIdentity, read, accepts, timeoutMs);
}

export async function selectSpace(
  client: AccountWorkspaceClient,
  name: string,
): Promise<void> {
  const selector = `button[aria-label=${JSON.stringify(name)}]`;
  await client.visible(selector, {}, 30_000);
  await client.tapCurrent(selector);
  await client.visible('[data-testid="space-actions-overflow"]', {}, 30_000);
}

export async function openSpaceMenu(
  client: AccountWorkspaceClient,
  name: string,
): Promise<void> {
  await selectSpace(client, name);
  await client.tapCurrent('[data-testid="space-actions-overflow"]');
}

export async function openSpaceSettings(
  client: AccountWorkspaceClient,
  name: string,
): Promise<void> {
  await openSpaceMenu(client, name);
  await client.tapCurrent('[data-testid="open-space-settings"]');
  await client.visible('[data-testid="space-settings"]', {}, 30_000);
  // Desktop opens General itself; avoid stealing its initial heading focus.
  if (
    !visibleOne(
      await client.elements('[data-testid="space-settings-panel-general"]'),
    )
  ) {
    await openSettingsSection(client, 'general');
  }
}

export async function openSettingsSection(
  client: AccountWorkspaceClient,
  section: 'general' | 'access' | 'contents' | 'addresses' | 'members',
): Promise<void> {
  const tab = `[data-testid="space-settings-tab-${section}"]`;
  if (!visibleOne(await client.elements(tab))) {
    await client.tapCurrent('[data-testid="space-settings-mobile-back"]');
  }
  await client.visible(tab);
  await client.tapCurrent(tab);
  await client.visible(`[data-testid="space-settings-panel-${section}"]`);
}
