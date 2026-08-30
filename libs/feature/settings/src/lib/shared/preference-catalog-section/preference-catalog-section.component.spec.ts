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
import { of } from 'rxjs';
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

  it('renders catalog labels in descriptor order', async () => {
    const { container } = await renderSection();
    const labels = Array.from(container.querySelectorAll('label')).map(
      (label) => label.textContent?.trim(),
    );

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
});
