import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { TrnRadioGroupComponent } from './trn-radio-group.component';
import { TrnRadioComponent } from './trn-radio.component';

@Component({
  standalone: true,
  imports: [TrnRadioGroupComponent, TrnRadioComponent],
  template: `
    <trn-radio-group [value]="value()" (valueChange)="value.set($event)">
      <trn-radio value="a" data-testid="a">A</trn-radio>
      <trn-radio value="b" data-testid="b">B</trn-radio>
    </trn-radio-group>
  `,
})
class HostComponent {
  readonly value = signal('a');
}

describe('TrnRadioGroupComponent / TrnRadioComponent', () => {
  it('shares a name and reflects the selected value on the native inputs', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    const inputs = el.querySelectorAll<HTMLInputElement>('input[type=radio]');
    expect(inputs.length).toBe(2);
    // Same generated name → browser-native single-selection group.
    expect(inputs[0].name).toBe(inputs[1].name);
    expect(inputs[0].name).toBeTruthy();
    expect(inputs[0].checked).toBe(true); // value() === 'a'
    expect(inputs[1].checked).toBe(false);
  });

  it('emits valueChange when another option is picked', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    const b = el.querySelector<HTMLInputElement>('[data-testid=b] input')!;
    b.checked = true;
    b.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(fixture.componentInstance.value()).toBe('b');
    const inputs = el.querySelectorAll<HTMLInputElement>('input[type=radio]');
    expect(inputs[0].checked).toBe(false);
    expect(inputs[1].checked).toBe(true);
  });
});
