import assert from 'node:assert/strict';
import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import { evaluateNative, waitForNativeShellState } from './native-shell-client.mts';

const source =
  'e2e/browser/journeys/room-administration/space-settings-resilience.spec.mts:199-205';

/**
 * Preserve the predecessor's one pointer-blocked transition. These are the only
 * two CDP-driven product clicks in this batch: the exact Account menu trigger
 * and the exact target Account row. Every other user action stays in Maestro.
 */
export async function switchBlockedSpaceSettingsAccount(
  client: AccountWorkspaceClient,
  targetUserId: string,
  assertionIdentity: string,
): Promise<void> {
  const opened = await evaluateNative(client.webview, `(() => {
    const element=document.querySelector('[data-testid="user-menu-trigger"]');
    if (!(element instanceof HTMLElement)) return false;
    element.click();
    return true;
  })()`);
  assert.equal(opened, true, `${source}: exact Account menu handler`);

  const selected = await evaluateNative(client.webview, `(() => {
    const target=${JSON.stringify(targetUserId)};
    const rows=[...document.querySelectorAll('[data-testid="account-row"]')];
    const element=rows.find(row => (row.textContent ?? '').includes(target));
    if (!(element instanceof HTMLElement)) return false;
    element.click();
    return true;
  })()`);
  assert.equal(selected, true, `${source}: exact Account row handler`);

  const active = await waitForNativeShellState(
    () =>
      evaluateNative(
        client.webview,
        `document.querySelector('.userbar__handle')?.textContent?.trim() ?? ''`,
      ),
    (value) => typeof value === 'string' && value.includes(targetUserId),
    `${assertionIdentity}: active Account changed`,
    client.signal,
    30_000,
  );
  await client.record(assertionIdentity, {
    assertion: assertionIdentity,
    source,
    active,
    transition: 'blocked Account menu and row handlers',
  });
}
