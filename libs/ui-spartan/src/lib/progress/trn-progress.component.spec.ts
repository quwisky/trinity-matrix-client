import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { TrnProgressComponent } from './trn-progress.component';

@Component({
  standalone: true,
  imports: [TrnProgressComponent],
  template: `<trn-progress [value]="v()" [indeterminate]="ind()" />`,
})
class HostComponent {
  readonly v = signal(0.5);
  readonly ind = signal(false);
}

describe('TrnProgressComponent', () => {
  it('sets the fill width from the 0–1 value and exposes aria-valuenow', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement.querySelector('trn-progress');
    const fill = host.querySelector('div') as HTMLElement;
    expect(fill.style.width).toBe('50%');
    expect(host.getAttribute('aria-valuenow')).toBe('0.5');
    expect(host.getAttribute('role')).toBe('progressbar');
  });

  it('clamps out-of-range values', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.v.set(1.5);
    fixture.detectChanges();
    const fill = fixture.nativeElement.querySelector(
      'trn-progress div',
    ) as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });

  it('drops aria-valuenow and animates when indeterminate', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.ind.set(true);
    fixture.detectChanges();
    const host = fixture.nativeElement.querySelector('trn-progress');
    expect(host.getAttribute('aria-valuenow')).toBeNull();
    expect(host.querySelector('.trn-progress__bar')).not.toBeNull();
  });
});
