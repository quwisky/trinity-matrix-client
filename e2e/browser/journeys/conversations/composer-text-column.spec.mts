import { test, expect } from '../../../fixtures.mts';
import { homeserverSession, login } from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';
import { testResourceId } from '../../../fixtures.mts';
import { DESIGN_VIEWPORTS } from '../../support/design-viewports.mts';
import { createRoom } from '../../support/space-journey.mts';

// On a phone the trailing buttons used to take most of the field, leaving ~170px for text.
const session = homeserverSession();

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
    const hs = session.hs as string;
    const user = `column-${testResourceId('run')}`;
    const pass = `${user}-pass`;
    await registerUser(request, user, pass);
    const account = await passwordLogin(request, hs, user, pass);
    const roomName = `Column ${user}`;
    await createRoom(
      request,
      hs,
      { accessToken: account.accessToken },
      roomName,
    );
    await login(page, { ...session, user, pass });
    await page.locator('.channel', { hasText: roomName }).first().click();
    const input = page.getByTestId('composer-input');
    await input.waitFor({ timeout: 30_000 });

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
            return r.width < 44 || r.height < 44;
          }).length,
        };
      });

    const empty = await measure();
    await input.fill('Hello there');
    const typing = await measure();
    // Insert, format and emoji stay in both states; Send joins once there is text.
    expect(empty.buttons).toHaveLength(3);
    expect(typing.buttons).toHaveLength(4);
    expect(empty.input / empty.field).toBeGreaterThanOrEqual(0.5);
    expect(empty.small + typing.small).toBe(0);
  });
});
