import { Component } from '@angular/core';
import { render, screen } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnSettingsRowComponent } from './trn-settings-row.component';

@Component({
  imports: [TrnSettingsRowComponent],
  template: `<trn-settings-row label="Theme" description="Pick one"
    ><button>Go</button></trn-settings-row
  >`,
})
class ControlHostComponent {}

@Component({
  imports: [TrnSettingsRowComponent],
  template: `<trn-settings-row label="Name" for="name-input"
    ><input id="name-input"
  /></trn-settings-row>`,
})
class LabelHostComponent {}

@Component({
  imports: [TrnSettingsRowComponent],
  template: `<trn-settings-row label="Theme" labelId="theme-heading"
    ><button role="combobox" aria-labelledby="theme-heading">
      Graphite
    </button></trn-settings-row
  >`,
})
class LabelIdHostComponent {}

describe('TrnSettingsRowComponent description', () => {
  it('gives the description an id derived from for, so the control can point at it', async () => {
    const { container } = await render(TrnSettingsRowComponent, {
      inputs: { label: 'Sound', description: 'Plays a chime', for: 'sound' },
    });
    expect(
      container.querySelector('#sound-description')?.textContent,
    ).toContain('Plays a chime');
  });
});

describe('TrnSettingsRowComponent', () => {
  it('renders label, description and the projected control', async () => {
    const { container } = await render(ControlHostComponent);
    expect(screen.getByText('Theme')).toBeTruthy();
    expect(screen.getByText('Pick one')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Go' })).toBeTruthy();
    expect(container.querySelector('[data-slot="settings-row"]')).toBeTruthy();
  });

  it('renders a label bound to the control when for is set', async () => {
    await render(LabelHostComponent);
    expect(screen.getByLabelText('Name').id).toBe('name-input');
  });

  it('puts labelId on the label so a control can be named by it', async () => {
    await render(LabelIdHostComponent);
    const combo = screen.getByRole('combobox');
    expect(combo.getAttribute('aria-labelledby')).toBe('theme-heading');
    expect(document.getElementById('theme-heading')?.textContent?.trim()).toBe(
      'Theme',
    );
  });

  it('has a subtle bottom divider, block padding and no inline spacing', async () => {
    const { fixture } = await render(TrnSettingsRowComponent, {
      inputs: { label: 'Theme' },
    });
    const row = fixture.nativeElement as HTMLElement;
    expect(row.classList.contains('border-b')).toBe(true);
    expect(row.className).toContain('--trinity-border-subtle');
    expect(row.classList.contains('py-3')).toBe(true);
    expect([...row.classList].filter((c) => /^(px|mx|ps|pe)-/.test(c))).toEqual(
      [],
    );
  });

  it('wraps instead of stacking: the label flexes and the control stays at the end', async () => {
    const { fixture } = await render(TrnSettingsRowComponent, {
      inputs: { label: 'Theme' },
    });
    const row = fixture.nativeElement as HTMLElement;
    expect(row.classList.contains('flex')).toBe(true);
    expect(row.classList.contains('flex-wrap')).toBe(true);
    expect(row.className).not.toContain('grid-cols');
    expect(row.className).not.toContain('max-sm:');
    const [label, control] = Array.from(row.children) as HTMLElement[];
    expect(label.className).toContain('flex-[1_1_12rem]');
    expect(control.className).toContain('ms-auto');
    expect(control.className).toContain('max-w-full');
  });
});
