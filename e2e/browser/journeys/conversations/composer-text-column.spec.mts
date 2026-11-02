import { test, expect, type Locator, type Page } from '../../../fixtures.mts';
import { homeserverSession, login } from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';
import { testResourceId } from '../../../fixtures.mts';
import { DESIGN_VIEWPORTS } from '../../support/design-viewports.mts';
import { createRoom } from '../../support/space-journey.mts';

// On a phone the trailing buttons used to take most of the field, leaving ~170px for text.
const session = homeserverSession();

async function openRoom(
  page: Page,
  request: Parameters<typeof registerUser>[0],
): Promise<Locator> {
  const hs = session.hs as string;
  const user = `column-${testResourceId('run')}`;
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  const account = await passwordLogin(request, hs, user, pass);
  const roomName = `Column ${user}`;
  await createRoom(request, hs, { accessToken: account.accessToken }, roomName);
  await login(page, { ...session, user, pass });
  await page.locator('.channel', { hasText: roomName }).first().click();
  const input = page.getByTestId('composer-input');
  await input.waitFor({ timeout: 30_000 });

  return input;
}

test.describe('Composer text column on a phone', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.use({
    ...DESIGN_VIEWPORTS['phone-pixel-5'],
    viewport: { width: 390, height: 844 },
  });

  test('gives an empty draft at least half the field, with 44pt targets', async ({
    page,
    request,
  }) => {
    const input = await openRoom(page, request);

    const measure = () =>
      page.getByTestId('composer-field').evaluate((field) => {
        const w = (el: Element) => el.getBoundingClientRect().width;
        const ta = field.querySelector('.composer__input') as Element;
        const buttons = [...field.querySelectorAll('button')].filter(
          (b) => b.getBoundingClientRect().width > 0,
        );
        return {
          field: w(field),
          input: w(ta),
          buttons: buttons.map((b) => {
            const r = b.getBoundingClientRect();
            return `${b.getAttribute('aria-label')}:${r.width}x${r.height}`;
          }),
          small: buttons.filter((b) => {
            const r = b.getBoundingClientRect();
            // Sub-pixel layout at a fractional device scale reads 43.999998 for a 44pt box.
            return r.width < 43.5 || r.height < 43.5;
          }).length,
        };
      });

    const empty = await measure();
    await input.fill('Hello there');
    const typing = await measure();
    // Format moved into the `+` sheet; Send only appears with something to send.
    await expect(page.getByTestId('composer-format')).toHaveCount(0);
    expect(empty.buttons).toHaveLength(2);
    expect(typing.buttons).toHaveLength(3);
    expect(empty.input / empty.field).toBeGreaterThanOrEqual(0.6);
    expect(typing.input / typing.field).toBeGreaterThanOrEqual(0.5);
    expect(empty.small).toBe(0);
    // Send's icon may still be mid-motion right after it mounts, so wait for it to settle.
    await expect.poll(async () => (await measure()).small).toBe(0);

    await page.getByTestId('composer-insert').click();
    await expect(page.getByTestId('insert-format')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('insert-format')).toBeHidden();
  });

  test('a paste into an empty field ends with no clipped line', async ({
    page,
    request,
  }) => {
    const input = await openRoom(page, request);
    await input.focus();
    await page.keyboard.insertText('word '.repeat(40).trim());
    await expect(page.getByTestId('composer-send')).toBeVisible();
    // Send mounting narrows the column after the first measure; the field must grow again.
    await expect
      .poll(() => input.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeLessThanOrEqual(1);
  });
});
