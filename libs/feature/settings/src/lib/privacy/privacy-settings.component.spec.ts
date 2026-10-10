import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  CONVERSATION_PRIVACY_PREFERENCES,
  UrlPreviewService,
  provideConversationPrivacyPreferences,
} from '@trinity/data-access/timeline';
import {
  MediaPickerService,
  PrivacySettingsService,
  providePrivacyPreferenceSet,
} from '@trinity/platform-native';
import { PREFERENCE_STORAGE_ADAPTER } from '@trinity/runtime/preferences';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { PrivacySettingsComponent } from './privacy-settings.component';

describe('PrivacySettingsComponent', () => {
  let previewsSupported: ReturnType<typeof signal<boolean | null>>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    previewsSupported = signal<boolean | null>(null);
  });

  function renderPage(captureSupported = false) {
    return render(PrivacySettingsComponent, {
      providers: [
        provideConversationPrivacyPreferences(),
        providePrivacyPreferenceSet(CONVERSATION_PRIVACY_PREFERENCES),
        {
          provide: PREFERENCE_STORAGE_ADAPTER,
          useValue: {
            read: () => of({ kind: 'missing' }),
            write: () => of({ kind: 'completed' }),
          },
        },
        MockProvider(UrlPreviewService, { supported: previewsSupported }),
        MockProvider(MediaPickerService, { captureSupported }),
      ],
    });
  }

  it('renders the complete privacy catalog journey', async () => {
    const { container } = await renderPage();

    expect(
      container.querySelector('[data-testid=privacy-send-read-receipts]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid=privacy-link-previews]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid=privacy-link-previews-encrypted]'),
    ).not.toBeNull();
  });

  it('hints when the homeserver does not provide link previews', async () => {
    const { fixture, container } = await renderPage();
    const hint = '[data-testid=privacy-link-previews-unsupported]';

    expect(container.querySelector(hint)).toBeNull();
    previewsSupported.set(false);
    fixture.detectChanges();
    expect(container.querySelector(hint)).not.toBeNull();
    previewsSupported.set(true);
    fixture.detectChanges();
    expect(container.querySelector(hint)).toBeNull();
  });

  it('does not hint while the catalog has link previews off', async () => {
    const { fixture, container } = await renderPage();
    previewsSupported.set(false);
    await firstValueFrom(
      TestBed.inject(PrivacySettingsService).setLinkPreviews(false),
    );
    fixture.detectChanges();

    expect(
      container.querySelector(
        '[data-testid=privacy-link-previews-unsupported]',
      ),
    ).toBeNull();
  });

  it('offers saving captures to the gallery, off, only where the native camera exists', async () => {
    const { container } = await renderPage(true);
    const row = container.querySelector(
      '[data-testid=privacy-save-captures-to-gallery]',
    );

    expect(row?.textContent).toContain(
      "Save photos and videos I take to this device's gallery",
    );
    expect(
      row?.querySelector<HTMLInputElement>('input[role="switch"]')?.checked,
    ).toBe(false);
  });

  it('leaves the gallery setting out where there is no native camera', async () => {
    const { container } = await renderPage(false);

    expect(
      container.querySelector('[data-testid=privacy-save-captures-to-gallery]'),
    ).toBeNull();
  });
});
