import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import { AdvancedSettingsResetService } from './advanced-settings-reset.service';
import { ConfigResetGroupComponent } from './config-reset-group.component';

function setup(result: unknown = null, resetting = false) {
  const start = vi.fn((onChanged: () => void) => onChanged());
  const retry = vi.fn();
  const entries = [{ entry: 'privacy.readReceipts', status: 'failed' }];
  return {
    start,
    retry,
    providers: [
      {
        provide: AdvancedSettingsResetService,
        useValue: {
          start,
          retry,
          resetting: signal(resetting),
          result: signal(result),
          outstandingEntries: signal(result ? entries : []),
        },
      },
    ],
  };
}

describe('ConfigResetGroupComponent', () => {
  it('starts a reset and announces the discard it asks for', async () => {
    const discarded = vi.fn();
    const { providers, start } = setup();
    const { container } = await render(ConfigResetGroupComponent, {
      providers,
      on: { discarded },
    });

    (
      container.querySelector('[data-testid=advanced-reset]') as HTMLElement
    ).click();

    expect(start).toHaveBeenCalledTimes(1);
    expect(discarded).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid=advanced-reset-partial]'),
    ).toBeNull();
  });

  it('lists outstanding entries and retries them', async () => {
    const { providers, retry } = setup({ kind: 'partial', attempt: 3 });
    const { container } = await render(ConfigResetGroupComponent, {
      providers,
    });

    expect(
      container.querySelector('[data-testid=advanced-reset-partial]')
        ?.textContent,
    ).toContain('privacy.readReceipts — failed');
    (
      container.querySelector(
        '[data-testid=advanced-reset-retry]',
      ) as HTMLElement
    ).click();

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('disables the button while resetting', async () => {
    const { providers } = setup(null, true);
    const { container } = await render(ConfigResetGroupComponent, {
      providers,
    });

    expect(
      (
        container.querySelector(
          '[data-testid=advanced-reset]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
