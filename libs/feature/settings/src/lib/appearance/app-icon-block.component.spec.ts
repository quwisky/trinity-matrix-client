import { signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { TrnSelectComponent } from '@trinity/components/controls';
import { TrnAlertService } from '@trinity/components/overlay';
import { render } from '@trinity/testing';
import { screen } from '@testing-library/angular';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppearanceSettingsController } from './appearance-settings.controller';
import { AppIconBlockComponent } from './app-icon-block.component';

const host = vi.hoisted(() => ({ value: 'desktop' as string }));
vi.mock('@trinity/platform-native', async (original) => ({
  ...(await original<object>()),
  appIconHost: () => host.value,
}));

const OPTIONS = [
  { value: 'system', label: 'Match system' },
  { value: 'blurple', label: 'Blurple' },
  { value: 'dark', label: 'Dark' },
];

async function setup(stored: string, confirmed = true) {
  const value = signal(stored);
  const controller = {
    axes: {
      appIcon: {
        value,
        editor: {
          label: 'App icon',
          description: 'Choose the icon Trinity shows outside the app.',
          options: OPTIONS,
        },
      },
    },
    status: { appIcon: { busy: signal(false), failed: signal(false) } },
    hydrationBusy: signal(false),
    update: vi.fn(),
    retry: vi.fn(),
  };
  const alerts = { confirm$: vi.fn(() => of(confirmed)) };
  const view = await render(AppIconBlockComponent, {
    providers: [
      { provide: AppearanceSettingsController, useValue: controller },
      { provide: TrnAlertService, useValue: alerts },
    ],
  });
  return { view, controller, alerts };
}

describe('AppIconBlockComponent', () => {
  beforeEach(() => (host.value = 'desktop'));

  it('offers Match system, Blurple and Dark with host help on desktop and applies directly', async () => {
    const { view, controller, alerts } = await setup('system');
    const block = view.fixture.componentInstance as unknown as {
      options(): { value: string }[];
      update(v: string): void;
    };
    expect(block.options().map((o) => o.value)).toEqual([
      'system',
      'blurple',
      'dark',
    ]);
    expect(screen.getByTestId('app-icon-help').textContent).toContain(
      'Changes the Dock / taskbar icon while Trinity is running.',
    );
    block.update('dark');
    expect(controller.update).toHaveBeenCalledWith('appIcon', 'dark');
    expect(alerts.confirm$).not.toHaveBeenCalled();
  });

  it('hides Match system on Android, shows a stored system as Blurple, and warns before switching', async () => {
    host.value = 'android';
    const { view, controller, alerts } = await setup('system');
    const block = view.fixture.componentInstance as unknown as {
      options(): { value: string }[];
      value(): string;
      update(v: string): void;
    };
    expect(block.options().map((o) => o.value)).toEqual(['blurple', 'dark']);
    expect(block.value()).toBe('blurple');

    block.update('blurple');
    expect(alerts.confirm$).not.toHaveBeenCalled();

    block.update('dark');
    expect(alerts.confirm$).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Changing the icon may close Trinity and remove pinned shortcuts on some launchers.',
      }),
    );
    expect(controller.update).toHaveBeenCalledWith('appIcon', 'dark');
  });

  it('keeps the icon when the Android warning is cancelled', async () => {
    host.value = 'android';
    const { view, controller } = await setup('blurple', false);
    (
      view.fixture.componentInstance as unknown as { update(v: string): void }
    ).update('dark');
    expect(controller.update).not.toHaveBeenCalled();
  });

  it('reverts the displayed select value when the Android warning is cancelled', async () => {
    host.value = 'android';
    const { view, controller } = await setup('blurple', false);
    const select = view.fixture.debugElement.query(
      By.directive(TrnSelectComponent),
    ).componentInstance as TrnSelectComponent<string>;
    select.value.set('dark');
    view.fixture.detectChanges();
    expect(select.value()).toBe('blurple');
    expect(controller.update).not.toHaveBeenCalled();
  });

  it.each([
    ['ios', 'iOS confirms the change with a system alert.'],
    ['web', 'Changes the browser tab icon.'],
  ])('explains where the change applies on %s', async (name, text) => {
    host.value = name;
    await setup('system');
    expect(screen.getByTestId('app-icon-help').textContent).toContain(text);
  });
});
