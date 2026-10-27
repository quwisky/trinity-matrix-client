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
import { render, screen } from '@trinity/testing';
import { TrnToastService } from '@trinity/components/overlay';
import { IgnoredUsersService } from '@trinity/data-access/identity';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { InvitePermissionService } from '@trinity/data-access/room-library';
import { MockProvider } from 'ng-mocks';
import { NEVER, firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivacySettingsComponent } from './privacy-settings.component';

describe('PrivacySettingsComponent', () => {
  let previewsSupported: ReturnType<typeof signal<boolean | null>>;
  let write: ReturnType<typeof vi.fn>;
  let inviteBlockingSupported: ReturnType<typeof signal<boolean | null>>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    previewsSupported = signal<boolean | null>(null);
    inviteBlockingSupported = signal<boolean | null>(true);
    write = vi.fn(() => of({ kind: 'completed' }));
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
            write,
          },
        },
        MockProvider(UrlPreviewService, { supported: previewsSupported }),
        MockProvider(MediaPickerService, { captureSupported }),
        MockProvider(InvitePermissionService, {
          supported: inviteBlockingSupported.asReadonly(),
          blocked: signal(false).asReadonly(),
          runProjection: () => NEVER,
        }),
        MockProvider(IgnoredUsersService, {
          ignoredUsers: signal([]).asReadonly(),
          runProjection: () => NEVER,
        }),
        MockProvider(SessionStateService, {
          activeAccountId: signal<string | null>('@me:hs').asReadonly(),
          accountIds: signal<readonly string[]>(['@me:hs']).asReadonly(),
        }),
        MockProvider(TrnToastService),
      ],
    });
  }

  it('groups the page as General, Invites and Blocked users', async () => {
    await renderPage();

    expect(
      screen
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent?.trim()),
    ).toEqual(['General', 'Invites', 'Blocked users']);
  });

  it('leaves out only the Invites group where the server cannot block invites', async () => {
    inviteBlockingSupported.set(false);
    await renderPage();

    expect(
      screen
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent?.trim()),
    ).toEqual(['General', 'Blocked users']);
  });

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

  it('offers keeping photo and video metadata, off, and explains what it shares', async () => {
    const { container } = await renderPage();

    const toggle = screen.getByRole('switch', {
      name: 'Keep photo and video metadata',
    });
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/photos and videos you send/);
    expect(toggle).toHaveAccessibleDescription(/where and on what device/);
    expect(toggle).toHaveAccessibleDescription(/HDR and Motion Photo/);
    expect(
      container.querySelector('[data-testid=privacy-keep-photo-metadata]')
        ?.textContent,
    ).toContain('Profile and room photos');
    expect(container.textContent).toContain(
      'link previews, photo and video metadata',
    );
  });

  it('saves keeping photo and video metadata on this device', async () => {
    const { fixture } = await renderPage();
    const toggle = screen.getByRole('switch', {
      name: 'Keep photo and video metadata',
    });

    toggle.click();
    await fixture.whenStable();

    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'trinity.privacy.keep-photo-metadata',
        storage: 'device-preferences',
        payload: '{"version":1,"value":true}',
      }),
    );
    expect(TestBed.inject(PrivacySettingsService).keepPhotoMetadata()).toBe(
      true,
    );
    expect(toggle).toBeChecked();
  });
});
