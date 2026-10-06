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
});
