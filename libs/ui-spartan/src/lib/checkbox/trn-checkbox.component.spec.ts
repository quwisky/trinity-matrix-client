import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { TrnCheckboxComponent } from './trn-checkbox.component';

@Component({
  standalone: true,
  imports: [TrnCheckboxComponent],
  template: `
    <trn-checkbox [checked]="on()" (checkedChange)="on.set($event)">
      Confirm
    </trn-checkbox>
  `,
})
class HostComponent {
  readonly on = signal(false);
}

describe('TrnCheckboxComponent', () => {
  it('reflects the checked input on the native input', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector(
      'input[type=checkbox]',
    ) as HTMLInputElement;
    expect(input.checked).toBe(false);

    fixture.componentInstance.on.set(true);
    fixture.detectChanges();
    expect(input.checked).toBe(true);
  });

  it('emits checkedChange when toggled', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector(
      'input[type=checkbox]',
    ) as HTMLInputElement;

    input.checked = true;
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(fixture.componentInstance.on()).toBe(true);
  });
});
