import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { TrnInputDirective } from './hlm-input.directive';
import { TrnLabelDirective } from '../label/hlm-label.directive';

@Component({
  standalone: true,
  imports: [TrnInputDirective, TrnLabelDirective],
  template: `
    <label trnLabel for="x">Name</label>
    <input trnInput id="x" />
    <input trnInput class="h-12" id="y" />
  `,
})
class HostComponent {}

function classesOf(el: HTMLElement): string[] {
  return el.getAttribute('class')?.split(/\s+/).filter(Boolean) ?? [];
}

describe('TrnInputDirective / TrnLabelDirective', () => {
  it('styles a native input with the helm field classes', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('#x');
    const classes = classesOf(input);
    expect(classes).toContain('rounded-md');
    expect(classes).toContain('border-input');
    expect(classes).toContain('border-solid'); // explicit — preflight is off
    expect(classes).toContain('h-9');
  });

  it('lets a caller class override the default height via tailwind-merge', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('#y');
    const classes = classesOf(input);
    expect(classes).toContain('h-12');
    expect(classes).not.toContain('h-9');
  });

  it('styles a native label', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    const label = fixture.nativeElement.querySelector('label');
    const classes = classesOf(label);
    expect(classes).toContain('text-sm');
    expect(classes).toContain('font-medium');
  });
});
