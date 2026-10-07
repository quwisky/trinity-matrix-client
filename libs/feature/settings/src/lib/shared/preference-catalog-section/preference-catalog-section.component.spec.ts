import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { TrnSwitchComponent } from '@trinity/components/controls';
import {
  PREFERENCE_STORAGE_ADAPTER,
  type PreferenceStorageWriteOutcome,
} from '@trinity/runtime/preferences';
import { provideConversationPrivacyPreferences } from '@trinity/data-access/timeline';
import { render } from '@trinity/testing';
import { of, Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreferenceCatalogSectionComponent } from './preference-catalog-section.component';

describe('PreferenceCatalogSectionComponent', () => {
  let writeOutcome: PreferenceStorageWriteOutcome;
  const write = vi.fn();

  beforeEach(() => {
    TestBed.resetTestingModule();
    writeOutcome = { kind: 'completed' };
    write.mockReset().mockImplementation(() => of(writeOutcome));
  });

  async function renderSection() {
    return render(PreferenceCatalogSectionComponent, {
      inputs: { section: 'privacy' },
      providers: [
        provideConversationPrivacyPreferences(),
        {
          provide: PREFERENCE_STORAGE_ADAPTER,
          useValue: {
            read: () => of({ kind: 'missing' }),
            write,
          },
        },
      ],
    });
  }

  function switchFor(
    fixture: ComponentFixture<PreferenceCatalogSectionComponent>,
    testId: string,
  ) {
    return fixture.debugElement
      .queryAll(By.directive(TrnSwitchComponent))
      .find((candidate) =>
        (candidate as { nativeElement: HTMLElement }).nativeElement.closest(
          `[data-testid=${testId}]`,
        ),
      ) as { componentInstance: TrnSwitchComponent } | undefined;
  }

  it('toggles a preference from its label and names the switch by it', async () => {
    const { container, fixture } = await renderSection();
    const row = container.querySelector<HTMLElement>(
      '[data-testid=privacy-send-read-receipts]',
    )!;
    const control = row.querySelector<HTMLInputElement>(
      'input[role="switch"]',
    )!;
    expect(control.labels?.[0]?.textContent?.trim()).toBe('Send read receipts');
    const description = control.getAttribute('aria-describedby')!;
    expect(row.querySelector(`#${description}`)).not.toBeNull();

    row.querySelector('label')!.click();
    fixture.detectChanges();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('renders catalog labels in descriptor order', async () => {
    const { container } = await renderSection();
    const labels = Array.from(
      container.querySelectorAll('trn-settings-row label'),
    ).map((label) => label.textContent?.trim());

    expect(labels).toEqual([
      'Send read receipts',
      'Show link previews',
      'Show link previews in encrypted rooms',
    ]);
  });

  it('persists a toggle through the cold preference command', async () => {
    const { fixture } = await renderSection();
    const control = switchFor(fixture, 'privacy-send-read-receipts')!;

    expect(control.componentInstance.checked()).toBe(true);
    control.componentInstance.checkedChange.emit(false);
    fixture.detectChanges();

    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: '{"version":1,"value":false}',
      }),
    );
    expect(control.componentInstance.checked()).toBe(false);
  });

  it('applies catalog visibility when its controlling preference changes', async () => {
    const { fixture, container } = await renderSection();
    const linkPreviews = switchFor(fixture, 'privacy-link-previews')!;

    linkPreviews.componentInstance.checkedChange.emit(false);
    fixture.detectChanges();

    expect(
      container.querySelector('[data-testid=privacy-link-previews-encrypted]'),
    ).toBeNull();
  });

  it('surfaces persistence recovery and preserves the current value', async () => {
    writeOutcome = {
      kind: 'unavailable',
      diagnostic: { code: 'device-preferences-write-failed' },
    };
    const { fixture, container } = await renderSection();
    const control = switchFor(fixture, 'privacy-send-read-receipts')!;

    control.componentInstance.checkedChange.emit(false);
    fixture.detectChanges();

    expect(control.componentInstance.checked()).toBe(true);
    expect(
      container.querySelector(
        '[data-testid=privacy-send-read-receipts-failure]',
      )?.textContent,
    ).toContain('could not be saved');
  });

  it('shows the new value while the save is pending and keeps it once saved', async () => {
    const pending = new Subject<PreferenceStorageWriteOutcome>();
    write.mockImplementationOnce(() => pending);
    const { fixture } = await renderSection();
    const control = switchFor(fixture, 'privacy-send-read-receipts')!;

    control.componentInstance.checkedChange.emit(false);
    fixture.detectChanges();
    expect(control.componentInstance.checked()).toBe(false);

    pending.next({ kind: 'completed' });
    pending.complete();
    fixture.detectChanges();
    expect(control.componentInstance.checked()).toBe(false);
  });

  it('reverts a pending value only when its save fails', async () => {
    const pending = new Subject<PreferenceStorageWriteOutcome>();
    write.mockImplementationOnce(() => pending);
    const { fixture } = await renderSection();
    const control = switchFor(fixture, 'privacy-send-read-receipts')!;

    control.componentInstance.checkedChange.emit(false);
    fixture.detectChanges();
    expect(control.componentInstance.checked()).toBe(false);

    pending.next({
      kind: 'unavailable',
      diagnostic: { code: 'device-preferences-write-failed' },
    });
    pending.complete();
    fixture.detectChanges();
    expect(control.componentInstance.checked()).toBe(true);
  });
});
