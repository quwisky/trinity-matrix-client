import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { HlmCheckbox } from '@trinity/helm/checkbox';
import { PrivacySettingsService } from '@trinity/platform-native';
import { UrlPreviewService } from '@trinity/data-access/timeline';
import { PrivacySettingsComponent } from './privacy-settings.component';

describe('PrivacySettingsComponent', () => {
  let sendReadReceipts: ReturnType<typeof signal<boolean>>;
  let linkPreviews: ReturnType<typeof signal<boolean>>;
  let linkPreviewsInEncrypted: ReturnType<typeof signal<boolean>>;
  let previewsSupported: ReturnType<typeof signal<boolean | null>>;

  beforeEach(() => {
    sendReadReceipts = signal(true);
    linkPreviews = signal(true);
    linkPreviewsInEncrypted = signal(false);
    previewsSupported = signal<boolean | null>(null);
  });

  function renderPage() {
    return render(PrivacySettingsComponent, {
      providers: [
        MockProvider(PrivacySettingsService, {
          sendReadReceipts,
          linkPreviews,
          linkPreviewsInEncrypted,
        }),
        MockProvider(UrlPreviewService, { supported: previewsSupported }),
      ],
    });
  }

  /** The `hlm-checkbox` inside the labelled toggle with the given testid. */
  function checkboxFor(
    container: HTMLElement,
    fixture: unknown,
    testid: string,
  ) {
    return (
      fixture as { debugElement: { queryAll: (p: unknown) => unknown[] } }
    ).debugElement
      .queryAll(By.directive(HlmCheckbox))
      .find((c) =>
        (c as { nativeElement: HTMLElement }).nativeElement.closest(
          `[data-testid=${testid}]`,
        ),
      ) as { componentInstance: HlmCheckbox } | undefined;
  }

  it('reflects and toggles the send-read-receipts preference', async () => {
    const { fixture, container } = await renderPage();
    const checkbox = checkboxFor(
      container,
      fixture,
      'privacy-send-read-receipts',
    )!;
    expect(checkbox.componentInstance.checked()).toBe(true);

    sendReadReceipts.set(false);
    fixture.detectChanges();
    expect(checkbox.componentInstance.checked()).toBe(false);

    checkbox.componentInstance.checkedChange.emit(true);
    expect(
      TestBed.inject(PrivacySettingsService).setSendReadReceipts,
    ).toHaveBeenCalledWith(true);
  });

  it('reflects and toggles the link-previews preference', async () => {
    const { fixture, container } = await renderPage();
    expect(
      container.querySelector('[data-testid=privacy-link-previews]'),
    ).not.toBeNull();
    const checkbox = checkboxFor(container, fixture, 'privacy-link-previews')!;
    expect(checkbox.componentInstance.checked()).toBe(true);

    checkbox.componentInstance.checkedChange.emit(false);
    expect(
      TestBed.inject(PrivacySettingsService).setLinkPreviews,
    ).toHaveBeenCalledWith(false);
  });

  it('reveals the encrypted-rooms toggle only while link previews are on', async () => {
    const { fixture, container } = await renderPage();
    expect(
      container.querySelector('[data-testid=privacy-link-previews-encrypted]'),
    ).not.toBeNull();

    linkPreviews.set(false);
    fixture.detectChanges();
    expect(
      container.querySelector('[data-testid=privacy-link-previews-encrypted]'),
    ).toBeNull();
  });

  it('reflects and toggles the encrypted-rooms previews preference', async () => {
    const { fixture, container } = await renderPage();
    const checkbox = checkboxFor(
      container,
      fixture,
      'privacy-link-previews-encrypted',
    )!;
    expect(checkbox.componentInstance.checked()).toBe(false);

    linkPreviewsInEncrypted.set(true);
    fixture.detectChanges();
    expect(checkbox.componentInstance.checked()).toBe(true);

    checkbox.componentInstance.checkedChange.emit(true);
    expect(
      TestBed.inject(PrivacySettingsService).setLinkPreviewsInEncrypted,
    ).toHaveBeenCalledWith(true);
  });

  it('hints when the homeserver does not provide link previews', async () => {
    const { fixture, container } = await renderPage();
    const hint = '[data-testid=privacy-link-previews-unsupported]';

    // Unknown support → no hint (don't cry wolf before we know).
    expect(container.querySelector(hint)).toBeNull();

    previewsSupported.set(false);
    fixture.detectChanges();
    expect(container.querySelector(hint)).not.toBeNull();

    // Supported again → hint gone.
    previewsSupported.set(true);
    fixture.detectChanges();
    expect(container.querySelector(hint)).toBeNull();
  });

  it('does not hint about server support while link previews are off', async () => {
    const { fixture, container } = await renderPage();
    previewsSupported.set(false);
    linkPreviews.set(false);
    fixture.detectChanges();

    expect(
      container.querySelector(
        '[data-testid=privacy-link-previews-unsupported]',
      ),
    ).toBeNull();
  });
});
