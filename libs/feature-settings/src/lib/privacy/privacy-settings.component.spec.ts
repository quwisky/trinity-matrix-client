import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { render } from '@testing-library/angular';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { HlmCheckbox } from '@trinity/helm/checkbox';
import { PrivacySettingsService } from '@trinity/platform-native';
import { PrivacySettingsComponent } from './privacy-settings.component';

describe('PrivacySettingsComponent', () => {
  let sendReadReceipts: ReturnType<typeof signal<boolean>>;

  beforeEach(() => {
    sendReadReceipts = signal(true);
  });

  function renderPage() {
    return render(PrivacySettingsComponent, {
      providers: [MockProvider(PrivacySettingsService, { sendReadReceipts })],
    });
  }

  it('reflects and toggles the send-read-receipts preference', async () => {
    const { fixture, container } = await renderPage();

    expect(
      container.querySelector('[data-testid=privacy-send-read-receipts]'),
    ).not.toBeNull();
    const checkbox = fixture.debugElement.query(By.directive(HlmCheckbox));
    expect(checkbox.componentInstance.checked()).toBe(true); // on by default

    // The checkbox reflects the persisted signal.
    sendReadReceipts.set(false);
    fixture.detectChanges();
    expect(checkbox.componentInstance.checked()).toBe(false);

    // Toggling emits checkedChange → the preference is persisted.
    checkbox.componentInstance.checkedChange.emit(true);
    expect(
      TestBed.inject(PrivacySettingsService).setSendReadReceipts,
    ).toHaveBeenCalledWith(true);
  });
});
