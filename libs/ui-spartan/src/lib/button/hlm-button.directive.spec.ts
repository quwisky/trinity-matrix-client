import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { TrnButtonDirective } from './hlm-button.directive';

@Component({
  standalone: true,
  imports: [TrnButtonDirective],
  template: `
    <button trnBtn>default</button>
    <button trnBtn variant="destructive" size="sm">danger</button>
    <button trnBtn class="px-10">override</button>
  `,
})
class HostComponent {}

function classesOf(el: HTMLElement): string[] {
  return el.getAttribute('class')?.split(/\s+/).filter(Boolean) ?? [];
}

describe('TrnButtonDirective', () => {
  it('applies the default variant + size classes on a bare button', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelectorAll('button')[0];
    const classes = classesOf(btn);
    expect(classes).toContain('bg-primary'); // default variant
    expect(classes).toContain('text-primary-foreground');
    expect(classes).toContain('h-9'); // default size
    expect(classes).toContain('inline-flex'); // base
  });

  it('applies the requested variant and size', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelectorAll('button')[1];
    const classes = classesOf(btn);
    expect(classes).toContain('bg-destructive'); // variant=destructive
    expect(classes).toContain('h-8'); // size=sm
    expect(classes).not.toContain('bg-primary');
    expect(classes).not.toContain('h-9');
  });

  it('lets a caller class override a conflicting default via tailwind-merge', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelectorAll('button')[2];
    const classes = classesOf(btn);
    expect(classes).toContain('px-10'); // caller override kept
    expect(classes).not.toContain('px-4'); // conflicting default dropped
  });
});
