import { Component, signal } from '@angular/core';
import { render, screen } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnSettingsGroupComponent } from './trn-settings-group.component';
import { TrnSettingsParts, slugify } from './trn-settings-parts';

@Component({
  imports: [TrnSettingsGroupComponent],
  template: `@if (shown()) {
    <trn-settings-group title="Theme" />
  }`,
})
class ToggleHostComponent {
  readonly shown = signal(true);
}

describe('TrnSettingsGroupComponent', () => {
  it('registers itself as a part of the enclosing settings layout', async () => {
    const parts = new TrnSettingsParts();
    await render(TrnSettingsGroupComponent, {
      inputs: { title: 'Code blocks' },
      providers: [{ provide: TrnSettingsParts, useValue: parts }],
    });
    expect(parts.parts().map((p) => p.id)).toEqual(['code-blocks']);
    const heading = screen.getByRole('heading', {
      level: 2,
      name: 'Code blocks',
    });
    expect(heading.id).toBe('part-code-blocks');
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  it('renders without a layout', async () => {
    await render(TrnSettingsGroupComponent, {
      inputs: { title: 'Theme' },
    });
    expect(
      screen.getByRole('heading', { level: 2, name: 'Theme' }),
    ).toBeTruthy();
  });

  it('honours an explicit partId and renders the description', async () => {
    const parts = new TrnSettingsParts();
    await render(TrnSettingsGroupComponent, {
      inputs: { title: 'Theme', partId: 'look', description: 'How it looks' },
      providers: [{ provide: TrnSettingsParts, useValue: parts }],
    });
    expect(parts.parts().map((p) => p.id)).toEqual(['look']);
    expect(screen.getByText('How it looks')).toBeTruthy();
  });

  it('unregisters when destroyed', async () => {
    const parts = new TrnSettingsParts();
    const { fixture } = await render(ToggleHostComponent, {
      providers: [{ provide: TrnSettingsParts, useValue: parts }],
    });
    expect(parts.parts()).toHaveLength(1);
    fixture.componentInstance.shown.set(false);
    fixture.detectChanges();
    expect(parts.parts()).toHaveLength(0);
  });

  it('keeps DOM order when groups register out of order', () => {
    const parts = new TrnSettingsParts();
    const first = document.createElement('h2');
    const second = document.createElement('h2');
    document.body.append(first, second);
    parts.register({ id: 'b', label: 'B', heading: second });
    parts.register({ id: 'a', label: 'A', heading: first });
    expect(parts.parts().map((p) => p.id)).toEqual(['a', 'b']);
    first.remove();
    second.remove();
  });

  it('styles the heading as a muted uppercase label', async () => {
    await render(TrnSettingsGroupComponent, {
      inputs: { title: 'Theme' },
    });
    const heading = screen.getByRole('heading', { level: 2 });
    for (const cls of ['uppercase', 'text-xs', 'font-bold']) {
      expect(heading.classList.contains(cls)).toBe(true);
    }
    expect(heading.className).toContain('--trinity-text-muted');
  });
});

describe('TrnSettingsGroupComponent spacing', () => {
  it('separates groups, and the heading from its first row, with block margin only', async () => {
    const { fixture } = await render(TrnSettingsGroupComponent, {
      inputs: { title: 'Theme', description: 'How it looks' },
    });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.classList.contains('mt-8')).toBe(true);
    expect(host.querySelector('section')!.classList.contains('mt-2')).toBe(
      true,
    );
    expect(host.className).not.toMatch(/\b(p|px|ps|pe)-/);
  });
});

describe('slugify', () => {
  it('lowercases and dashes', () => {
    expect(slugify('Code blocks')).toBe('code-blocks');
  });
  it('folds accents and trims dashes', () => {
    expect(slugify('  Ä & B ')).toBe('a-b');
  });
});
