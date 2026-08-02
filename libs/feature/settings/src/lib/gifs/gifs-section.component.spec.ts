import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it } from 'vitest';
import {
  GifSettingsService,
  type GifProviderId,
} from '@trinity/data-access/gif';
import { GifsSectionComponent } from './gifs-section.component';

function providers(
  overrides: {
    provider?: GifProviderId;
    apiKey?: string;
    configured?: boolean;
  } = {},
) {
  return [
    MockProvider(GifSettingsService, {
      provider: signal<GifProviderId>(
        overrides.provider ?? 'tenor',
      ).asReadonly(),
      apiKey: signal(overrides.apiKey ?? '').asReadonly(),
      configured: signal(overrides.configured ?? false).asReadonly(),
    }),
  ];
}

describe('GifsSectionComponent', () => {
  it('renders a radio option for each provider', async () => {
    const { container } = await render(GifsSectionComponent, {
      providers: providers(),
    });
    expect(
      container.querySelector('[data-testid=gif-provider-tenor]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid=gif-provider-giphy]'),
    ).not.toBeNull();
  });

  it('disables Save until a key is entered', async () => {
    const { container } = await render(GifsSectionComponent, {
      providers: providers(),
    });
    const save = container.querySelector(
      '[data-testid=gif-save]',
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('saves the provider and API key when Save is clicked', async () => {
    const { container, fixture } = await render(GifsSectionComponent, {
      providers: providers(),
    });
    const input = container.querySelector(
      '[data-testid=gif-api-key]',
    ) as HTMLInputElement;
    input.value = 'my-key';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const save = container.querySelector(
      '[data-testid=gif-save]',
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    save.click();

    const settings = TestBed.inject(GifSettingsService);
    expect(settings.save).toHaveBeenCalledWith('tenor', 'my-key');
  });

  it('hides Clear when not configured', async () => {
    const { container } = await render(GifsSectionComponent, {
      providers: providers(),
    });
    expect(container.querySelector('[data-testid=gif-clear]')).toBeNull();
  });

  it('offers Clear when configured and clears on click', async () => {
    const { container } = await render(GifsSectionComponent, {
      providers: providers({ apiKey: 'k', configured: true }),
    });
    const clear = container.querySelector(
      '[data-testid=gif-clear]',
    ) as HTMLButtonElement;
    expect(clear).not.toBeNull();
    clear.click();

    const settings = TestBed.inject(GifSettingsService);
    expect(settings.clear).toHaveBeenCalled();
  });
});
