import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import {
  TrnSelectComponent,
  TrnSwitchComponent,
} from '@trinity/components/controls';
import {
  definePreference,
  PREFERENCE_STORAGE_ADAPTER,
  providePreferenceDescriptors,
  type PreferenceDescriptor,
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

  it('shows the stored value in the native switch after a synchronous failed save', async () => {
    writeOutcome = {
      kind: 'unavailable',
      diagnostic: { code: 'device-preferences-write-failed' },
    };
    const { fixture, container } = await renderSection();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid=privacy-send-read-receipts] input[role="switch"]',
    )!;
    expect(input.checked).toBe(true);

    input.click();
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(write).toHaveBeenCalledTimes(1);
    expect(input.checked).toBe(true);
    expect(input.getAttribute('aria-checked')).toBe('true');
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

const SAMPLE_SELECT = definePreference({
  id: 'test.sample-select',
  owner: 'workspace',
  section: 'sample',
  order: 1,
  scope: 'installation',
  defaultValue: 'a',
  sensitivity: 'public',
  storage: 'device-preferences',
  export: 'excluded',
  editor: {
    kind: 'select',
    label: 'Sample choice',
    description: 'Pick one.',
    testId: 'sample-choice',
    options: [
      { value: 'a', label: 'Option A' },
      { value: 'b', label: 'Option B' },
    ],
  },
  persistence: {
    key: 'trinity.test.sample-select',
    migration: {
      currentVersion: 1,
      migrate: (stored) =>
        stored.value === 'a' || stored.value === 'b'
          ? { kind: 'accepted', value: stored.value }
          : { kind: 'rejected', diagnostic: { code: 'x' } },
    },
  },
  validate: (value) =>
    value === 'a' || value === 'b'
      ? { kind: 'accepted', value }
      : { kind: 'rejected', diagnostic: { code: 'x' } },
} satisfies PreferenceDescriptor<'a' | 'b'>);

describe('PreferenceCatalogSectionComponent select editor', () => {
  async function renderSelect(
    outcome: PreferenceStorageWriteOutcome = { kind: 'completed' },
  ) {
    const write = vi.fn(() => of(outcome));
    TestBed.resetTestingModule();
    const rendered = await render(PreferenceCatalogSectionComponent, {
      inputs: { section: 'sample' },
      providers: [
        providePreferenceDescriptors(() => [SAMPLE_SELECT]),
        {
          provide: PREFERENCE_STORAGE_ADAPTER,
          useValue: { read: () => of({ kind: 'missing' }), write },
        },
      ],
    });
    return { ...rendered, write };
  }

  function selectOf(fixture: ComponentFixture<unknown>) {
    return fixture.debugElement.query(By.directive(TrnSelectComponent))
      .componentInstance as TrnSelectComponent<string>;
  }

  it('names the select by its row label and shows the current value', async () => {
    const { container } = await renderSelect();
    const combobox = container.querySelector(
      '[data-testid=sample-choice] [role=combobox]',
    )!;

    expect(
      container.querySelector('#sample-choice-heading')?.textContent,
    ).toContain('Sample choice');
    expect(combobox.getAttribute('aria-labelledby')).toBe(
      'sample-choice-heading',
    );
    expect(
      container.querySelector('[data-testid=sample-choice-select]')
        ?.textContent,
    ).toContain('Option A');
  });

  it('saves the chosen option', async () => {
    const { fixture, write } = await renderSelect();

    selectOf(fixture).value.set('b');
    fixture.detectChanges();

    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: JSON.stringify({ version: 1, value: 'b' }),
      }),
    );
  });

  it('reports a failed save under the select', async () => {
    const { fixture, container } = await renderSelect({
      kind: 'unavailable',
      diagnostic: { code: 'x' },
    });

    selectOf(fixture).value.set('b');
    fixture.detectChanges();

    expect(
      container.querySelector(
        '[data-testid=sample-choice-failure][role=alert]',
      ),
    ).not.toBeNull();
  });

  it('shows the stored option again after a synchronous failed save', async () => {
    const { fixture, container, write } = await renderSelect({
      kind: 'unavailable',
      diagnostic: { code: 'x' },
    });

    selectOf(fixture).value.set('b');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(selectOf(fixture).value()).toBe('a');
    expect(
      container.querySelector('[data-testid=sample-choice-select]')
        ?.textContent,
    ).toContain('Option A');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('saves a failed choice again when the user picks it again', async () => {
    const { fixture, write } = await renderSelect({
      kind: 'unavailable',
      diagnostic: { code: 'x' },
    });

    selectOf(fixture).value.set('b');
    fixture.detectChanges();
    selectOf(fixture).value.set('b');
    fixture.detectChanges();

    expect(write).toHaveBeenCalledTimes(2);
  });
});
