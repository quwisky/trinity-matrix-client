import assert from 'node:assert/strict';
import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import { evaluateNative, waitForNativeShellState } from './native-shell-client.mts';

const source =
  'e2e/browser/journeys/room-administration/room-profile-settings.spec.mts:324-335';

/**
 * Preserve the predecessor's pointer-blocked external Account transition.
 * These exact menu/row handlers are the only two CDP product clicks in #717.
 */
export async function switchBlockedRoomSettingsAccount(
  client: AccountWorkspaceClient,
  targetUserId: string,
  rowAssertionIdentity: string,
  activeAssertionIdentity: string,
): Promise<void> {
  const opened = await evaluateNative(
    client.webview,
    `(() => {
      const element=document.querySelector('[data-testid="user-menu-trigger"]');
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })()`,
  );
  assert.equal(opened, true, `${source}: exact Account menu handler`);

  const rows = await client.waitElements(
    '[data-testid="account-row"]',
    (elements) => elements.length === 1 && elements[0]!.visible,
    `${rowAssertionIdentity}: exact target Account row visible`,
    { text: targetUserId },
    30_000,
  );
  await client.record(rowAssertionIdentity, {
    assertion: rowAssertionIdentity,
    source,
    observation: rows,
  });

  const selected = await evaluateNative(
    client.webview,
    `(() => {
      const target=${JSON.stringify(targetUserId)};
      const rows=[...document.querySelectorAll('[data-testid="account-row"]')];
      const element=rows.find(row => (row.textContent ?? '').includes(target));
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })()`,
  );
  assert.equal(selected, true, `${source}: exact Account row handler`);

  const active = await waitForNativeShellState(
    () =>
      evaluateNative(
        client.webview,
        `document.querySelector('.userbar__handle')?.textContent?.trim() ?? ''`,
      ),
    (value) => typeof value === 'string' && value.includes(targetUserId),
    `${activeAssertionIdentity}: active Account changed`,
    client.signal,
    30_000,
  );
  await client.record(activeAssertionIdentity, {
    assertion: activeAssertionIdentity,
    source,
    active,
    transition: 'blocked Account menu and row handlers',
  });
}
