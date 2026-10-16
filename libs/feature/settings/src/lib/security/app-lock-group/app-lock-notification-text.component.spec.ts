import type { NotificationText } from '@trinity/data-access/app-lock';
import {
  AppSettingsService,
  type NotificationPreviewSetting,
} from '@trinity/platform-native';
import { HostLifecycleService } from '@trinity/runtime/host';
import { fireEvent, render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Subject, of, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AppLockNotificationTextComponent } from './app-lock-notification-text.component';

type LifecycleEvent = { kind: 'active' } | { kind: 'background' };

const HINT = /Follows your phone’s lock-screen notification setting\./;
const PREVIEWS_NOTE =
  'Your iPhone currently shows previews on the lock screen. Set Show Previews to When Unlocked.';

/** One macrotask for the zoneless renderer. */
const tick = () => new Promise((resolve) => setTimeout(resolve));

async function setup(
  options: {
    value?: NotificationText;
    disabled?: boolean;
    /** Phones: "Hide on the lock screen" is offered. */
    lockScreenOffered?: boolean;
    /** Whether the host can open its settings (iOS and Android). */
    available?: boolean;
    /** What each read of iOS's Show Previews answers, in order; the last one repeats. */
    previews?: readonly (NotificationPreviewSetting | null)[];
    lifecycle?: Observable<LifecycleEvent>;
  } = {},
) {
  const previews = [...(options.previews ?? [null])];
  const appSettings = {
    available: options.available ?? true,
    openNotificationSettings: vi.fn(() => of(true)),
    previewSetting: vi.fn(() =>
      of(previews.length > 1 ? (previews.shift() ?? null) : previews[0]),
    ),
  };
  const chosen = vi.fn();
  const view = await render(AppLockNotificationTextComponent, {
    inputs: {
      value: options.value ?? 'show',
      disabled: options.disabled ?? false,
      lockScreenOffered: options.lockScreenOffered ?? true,
    },
    on: { valueChange: chosen },
    providers: [
      MockProvider(AppSettingsService, appSettings as never),
      MockProvider(HostLifecycleService, {
        events: options.lifecycle ?? of<LifecycleEvent>(),
      }),
    ],
  });
  return { view, appSettings, chosen };
}

function choice(name: RegExp): HTMLInputElement {
  return screen.getByRole('radio', { name }) as HTMLInputElement;
}

function settingsLink(): HTMLElement | null {
  return screen.queryByRole('button', { name: 'Open notification settings' });
}

describe('AppLockNotificationTextComponent', () => {
  it('offers three choices on a phone, named by their row', async () => {
    await setup({ value: 'hide-on-lock-screen' });
    expect(
      screen.getByRole('radiogroup', { name: 'Notification text' }),
    ).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(choice(/^Show/).checked).toBe(false);
    expect(choice(/^Hide on the lock screen/).checked).toBe(true);
    expect(choice(/^Always hide/).checked).toBe(false);
  });

  it('says what each choice shows', async () => {
    await setup();
    expect(choice(/^Show/).closest('label')?.textContent).toMatch(
      /Notifications show who wrote, in which room, and the message\./,
    );
    expect(choice(/^Always hide/).closest('label')?.textContent).toMatch(
      /Notifications say only “New message”, everywhere\./,
    );
  });

  it('says “Hide on the lock screen” follows the phone’s setting, whichever choice is selected', async () => {
    await setup({ value: 'show' });
    const option = choice(/^Hide on the lock screen/).closest('label');
    expect(option?.textContent).toMatch(
      /The lock screen says only “New message”; the full text shows once your phone is unlocked\./,
    );
    expect(option?.textContent).toMatch(HINT);
    expect(settingsLink()).toBeTruthy();
  });

  it('opens the notification settings', async () => {
    const { appSettings } = await setup();
    fireEvent.click(settingsLink() as HTMLElement);
    expect(appSettings.openNotificationSettings).toHaveBeenCalledOnce();
  });

  it('says when iOS shows previews on the lock screen', async () => {
    await setup({ previews: ['always'] });
    expect(screen.getByText(PREVIEWS_NOTE)).toBeTruthy();
  });

  it.each(['when-unlocked', 'never', null] as const)(
    'says nothing more when Show Previews is %s',
    async (previews) => {
      await setup({ previews: [previews] });
      expect(screen.queryByText(PREVIEWS_NOTE)).toBeNull();
    },
  );

  it('reads Show Previews again when the app comes back', async () => {
    const lifecycle = new Subject<LifecycleEvent>();
    const { view, appSettings } = await setup({
      previews: ['always', 'when-unlocked'],
      lifecycle,
    });
    expect(screen.getByText(PREVIEWS_NOTE)).toBeTruthy();
    lifecycle.next({ kind: 'background' });
    expect(appSettings.previewSetting).toHaveBeenCalledOnce();
    lifecycle.next({ kind: 'active' });
    await tick();
    view.fixture.detectChanges();
    expect(appSettings.previewSetting).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(PREVIEWS_NOTE)).toBeNull();
  });

  it('offers no settings link, and reads no setting, where the host can’t open its settings', async () => {
    const { appSettings } = await setup({ available: false });
    expect(choice(/^Hide on the lock screen/)).toBeTruthy();
    expect(settingsLink()).toBeNull();
    expect(appSettings.previewSetting).not.toHaveBeenCalled();
  });

  it('offers only Show and Always hide on a desktop, with no hint or link', async () => {
    await setup({ lockScreenOffered: false, previews: ['always'] });
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(choice(/^Show/)).toBeTruthy();
    expect(choice(/^Always hide/)).toBeTruthy();
    expect(screen.queryByText(HINT)).toBeNull();
    expect(screen.queryByText(PREVIEWS_NOTE)).toBeNull();
    expect(settingsLink()).toBeNull();
  });

  it('reports the choice made', async () => {
    const { chosen } = await setup();
    fireEvent.click(choice(/^Always hide/));
    expect(chosen).toHaveBeenCalledWith('always-hide');
  });

  it('can’t be changed while disabled', async () => {
    await setup({ disabled: true });
    expect(choice(/^Always hide/).disabled).toBe(true);
  });
});
