import { Component, signal } from '@angular/core';
import { render } from '@trinity/testing';
import { provideTrnIcons } from '@trinity/components/foundations';
import { expectTypeOf } from 'vitest';
import {
  TrnSettingsLayoutComponent,
  type TrnSettingsLayoutSection,
} from './trn-settings-layout.component';

const sections: readonly TrnSettingsLayoutSection[] = [
  { id: 'general', label: 'General', icon: 'settings', group: 'Basics' },
  { id: 'advanced', label: 'Advanced', icon: 'code', group: 'More' },
];

@Component({
  imports: [TrnSettingsLayoutComponent],
  template: `
    <trn-settings-layout
      title="Preferences"
      [sections]="sections"
      [selectedSection]="selected()"
      [compact]="compact()"
      [directoryVisible]="directoryVisible()"
      (sectionSelected)="selected.set($event)"
    >
      <span settings-context>Context</span>
      <p settings-warning>Warning</p>
      <p settings-directory-header>Directory controls</p>
      <p settings-nav-footer>Build 1</p>
      <h2>General</h2>
    </trn-settings-layout>
  `,
})
class SettingsLayoutHostComponent {
  readonly sections = sections;
  readonly selected = signal<string | null>('general');
  readonly compact = signal(false);
  readonly directoryVisible = signal(true);
}

describe('TrnSettingsLayoutComponent', () => {
  it('publishes the domain-neutral section contract', () => {
    expectTypeOf<TrnSettingsLayoutSection>().toEqualTypeOf<{
      readonly id: string;
      readonly label: string;
      readonly icon: import('@trinity/components/foundations').TrnIconName;
      readonly group?: string;
    }>();
  });

  it('renders the projected context, warning, footer, and selected directory state', async () => {
    const { container } = await render(SettingsLayoutHostComponent, {
      providers: [provideTrnIcons()],
    });

    expect(container.querySelector('h1')?.textContent?.trim()).toBe(
      'Preferences',
    );
    expect(container.querySelector('nav')?.getAttribute('aria-label')).toBe(
      'Preferences sections',
    );
    expect(
      container.querySelector('nav [settings-directory-header]')?.textContent,
    ).toBe('Directory controls');
    expect(
      container.querySelector('[settings-context]')?.textContent,
    ).toContain('Context');
    expect(
      container.querySelector('[settings-warning]')?.textContent,
    ).toContain('Warning');
    expect(
      container.querySelector('[settings-nav-footer]')?.textContent,
    ).toContain('Build 1');
    expect(
      container.querySelector('[data-testid="settings-tab-general"]'),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('emits selection and uses the compact directory visibility for pane swapping', async () => {
    const { container, fixture } = await render(SettingsLayoutHostComponent, {
      providers: [provideTrnIcons()],
    });
    const host = fixture.componentInstance;

    container
      .querySelector<HTMLButtonElement>('[data-testid="settings-tab-advanced"]')
      ?.click();
    expect(host.selected()).toBe('advanced');

    host.directoryVisible.set(false);
    fixture.detectChanges();
    expect(
      container
        .querySelector<HTMLElement>('[data-testid="settings-directory"]')
        ?.classList.contains('settings-pane--hidden'),
    ).toBe(false);

    host.compact.set(true);
    host.directoryVisible.set(true);
    fixture.detectChanges();
    expect(
      container
        .querySelector<HTMLElement>('[data-testid="settings-detail"]')
        ?.classList.contains('settings-pane--hidden'),
    ).toBe(true);
    expect(
      container.querySelector('[data-testid="settings-mobile-back"]'),
    ).toBeNull();

    host.directoryVisible.set(false);
    fixture.detectChanges();
    expect(
      container
        .querySelector<HTMLElement>('[data-testid="settings-detail"]')
        ?.classList.contains('settings-pane--hidden'),
    ).toBe(false);
    expect(
      container
        .querySelector<HTMLElement>('[data-testid="settings-directory"]')
        ?.classList.contains('settings-pane--hidden'),
    ).toBe(true);
    expect(
      container.querySelector('[data-testid="settings-mobile-back"]'),
    ).toBeTruthy();
  });
});
