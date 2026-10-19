import { expect, type Page } from '@playwright/test';

/** Opens a member's card from the conversation member list. */
export async function openMemberCard(
  page: Page,
  memberName: string,
): Promise<void> {
  if (!(await page.locator('.chat-members').isVisible())) {
    await page.getByTestId('toggle-members').click();
  }
  const memberRow = page.locator('[data-testid="member-row"]', {
    hasText: memberName,
  });
  await memberRow.first().waitFor({ state: 'visible', timeout: 20_000 });
  await memberRow.first().click();
  await expect(page.getByTestId('member-info')).toBeVisible({
    timeout: 10_000,
  });
}

/** Selects a tab on the open member card; "Rooms" also matches its "Rooms (n)" label. */
export async function openMemberTab(
  page: Page,
  tab: 'Profile' | 'Rooms' | 'Manage',
): Promise<void> {
  const button = page
    .getByTestId('member-info')
    .getByRole('tab', { name: tab });
  await button.click();
  await expect(button).toHaveAttribute('aria-selected', 'true');
}
