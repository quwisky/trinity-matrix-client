import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  it('keeps compact section navigation with the directory hidden', async () => {
    const { container, getByRole } = await render(TrnSettingsLayoutComponent, {
      inputs: {
        title: 'System status',
        sections,
        selectedSection: 'general',
        compact: true,
        directoryVisible: false,
      },
      providers: [provideTrnIcons()],
    });
    expect(getByRole('button', { name: 'Back to sections' })).toBeTruthy();
    expect(container.querySelector('nav')).toHaveClass('settings-pane--hidden');
  });

  describe('full-screen layer', () => {
    const css = readFileSync(
      join(import.meta.dirname, 'trn-settings-layout.component.scss'),
      'utf8',
    );
    const rule = (selector: string): string =>
      new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'u').exec(
        css,
      )?.[1] ?? '';

    it('puts the nav on the app ground and the content on the pane', async () => {
      const { container } = await render(SettingsLayoutHostComponent, {
        providers: [provideTrnIcons()],
      });
      expect(container.querySelector('.settings-layout__nav')).toBeTruthy();
      expect(container.querySelector('.settings-layout__content')).toBeTruthy();
      expect(container.querySelector('[trnoverlaysurface]')).toBeNull();
      const nav = rule('.settings-layout__nav');
      expect(nav).toContain('background: var(--trinity-surface-app)');
      expect(nav).toContain('flex: 0 0 35%');
      expect(nav).toContain('min-inline-size: 218px');
      const inner = rule('.settings-layout__nav-inner');
      expect(inner).toContain('inline-size: 192px');
      expect(inner).toContain('margin-inline-start: auto');
      expect(rule('.settings-layout__group-label')).toContain(
        'text-transform: uppercase',
      );
      expect(rule('.settings-layout__content')).toContain(
        'background: var(--trinity-surface-pane)',
      );
      expect(rule('.settings-layout__column')).toContain(
        'max-inline-size: 740px',
      );
      const title = rule('.settings-layout__column h1');
      expect(title).toContain('font-size: var(--trinity-text-lg)');
      expect(title).toContain('font-weight: 700');
    });

    it('renders the context and warning before the section title', async () => {
      const { container } = await render(SettingsLayoutHostComponent, {
        providers: [provideTrnIcons()],
      });
      const column = container.querySelector('.settings-layout__column')!;
      const order = Array.from(column.children).map(
        (el) =>
          el.getAttribute('settings-context') ??
          el.getAttribute('settings-warning') ??
          el.tagName,
      );
      expect(order.slice(0, 3)).toEqual(['', '', 'H1']);
      expect(column.children[0]?.textContent).toContain('Context');
      expect(column.children[1]?.textContent).toContain('Warning');
    });

    it('closes from a round close button with a hidden ESC caption', async () => {
      const closeRequested = vi.fn();
      const { getByRole, container } = await render(
        TrnSettingsLayoutComponent,
        {
          inputs: {
            title: 'Preferences',
            sections,
            selectedSection: 'general',
          },
          on: { closeRequested },
          providers: [provideTrnIcons()],
        },
      );
      const close = getByRole('button', { name: 'Close settings' });
      expect(
        container
          .querySelector('.settings-layout__close-caption')
          ?.getAttribute('aria-hidden'),
      ).toBe('true');
      expect(
        container.querySelector('.settings-layout__close-caption')?.textContent,
      ).toContain('ESC');
      close.click();
      expect(closeRequested).toHaveBeenCalledTimes(1);
    });

    it('closes on Escape and handles it once', async () => {
      const closeRequested = vi.fn();
      const { container } = await render(TrnSettingsLayoutComponent, {
        inputs: { title: 'Preferences', sections, selectedSection: 'general' },
        on: { closeRequested },
        providers: [provideTrnIcons()],
      });
      const reachedBody = vi.fn();
      document.body.addEventListener('keydown', reachedBody);
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      container.querySelector('button')!.dispatchEvent(event);
      document.body.removeEventListener('keydown', reachedBody);
      expect(closeRequested).toHaveBeenCalledTimes(1);
      // The CDK dialog listens on the body; it must not also close the layer.
      expect(reachedBody).not.toHaveBeenCalled();
    });

    it('returns to the directory on Escape when compact with a section open', async () => {
      const closeRequested = vi.fn();
      const backRequested = vi.fn();
      const { container } = await render(TrnSettingsLayoutComponent, {
        inputs: {
          title: 'Preferences',
          sections,
          selectedSection: 'general',
          compact: true,
          directoryVisible: false,
        },
        on: { closeRequested, backRequested },
        providers: [provideTrnIcons()],
      });
      container.querySelector('button')!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(backRequested).toHaveBeenCalledTimes(1);
      expect(closeRequested).not.toHaveBeenCalled();
    });
  });

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
