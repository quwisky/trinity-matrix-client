import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { TrnBadgeDirective } from './trn-badge.directive';

@Component({
  standalone: true,
  imports: [TrnBadgeDirective],
  template: `
    <span trnBadge data-t="d">Default</span>
    <span trnBadge variant="success" data-t="s">Verified</span>
    <span trnBadge variant="warning" data-t="w">Unverified</span>
  `,
})
class HostComponent {}

function classesOf(el: Element): string[] {
  return el.getAttribute('class')?.split(/\s+/).filter(Boolean) ?? [];
}

describe('TrnBadgeDirective', () => {
  it('applies the default (primary) variant', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const classes = classesOf(
      fixture.nativeElement.querySelector('[data-t=d]'),
    );
    expect(classes).toContain('bg-primary');
    expect(classes).toContain('inline-flex');
    expect(classes).toContain('rounded-md');
  });

  it('applies the success and warning status variants', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    expect(
      classesOf(fixture.nativeElement.querySelector('[data-t=s]')),
    ).toContain('bg-success');
    expect(
      classesOf(fixture.nativeElement.querySelector('[data-t=w]')),
    ).toContain('bg-warning');
  });
});
