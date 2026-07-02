import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { describe, expect, it } from 'vitest';
// Imported straight from the owning helm libs (not the `@trinity/ui-spartan`
// barrel that re-exports them) — this file lives inside ui-spartan itself, and
// @nx/enforce-module-boundaries treats importing a project's own path alias as a
// self-import to flag/autofix, which crashes on this workspace's plugin version.
// These are the same symbols ui-spartan's index.ts re-exports, so coverage is
// identical from the app's point of view.
import { badgeVariants } from '@trinity/helm/badge';
import { buttonVariants, HlmButton } from '@trinity/helm/button';
import { HlmCheckbox } from '@trinity/helm/checkbox';
import { HlmInput } from '@trinity/helm/input';
import { HlmSpinner } from '@trinity/helm/spinner';

// The generated helm libs (libs/spartan/*) shipped with no specs of their own, and
// the old Trn* wrapper specs were deleted when the app swapped to these directly.
// This restores focused coverage for the pieces most likely to regress silently:
// our badge cva customization (success/warning tokens), the button cva contract,
// and a render smoke test proving each directive/component instantiates.
//
// NOTE: helm components style their host via the async `classes()` manager (an
// `effect()` + a global `MutationObserver`, see libs/spartan/utils/src/lib/hlm.ts).
// That host `class` string is applied on a microtask/animation-frame schedule, so
// asserting exact host className text here would be flaky. Instead we assert the
// cva functions directly (pure, synchronous) and that components render without
// throwing — never the applied host classes.

describe('badgeVariants (hlm-badge cva)', () => {
  it('maps the success status variant to the success token classes', () => {
    const classes = badgeVariants({ variant: 'success' });
    expect(classes).toContain('bg-success');
    expect(classes).toContain('text-success-foreground');
  });

  it('maps the warning status variant to the warning token classes', () => {
    const classes = badgeVariants({ variant: 'warning' });
    expect(classes).toContain('bg-warning');
    expect(classes).toContain('text-warning-foreground');
  });

  it('still resolves the stock default variant', () => {
    const classes = badgeVariants({ variant: 'default' });
    expect(classes).toContain('bg-primary');
    expect(classes).toContain('text-primary-foreground');
  });

  it('still resolves the stock destructive variant', () => {
    const classes = badgeVariants({ variant: 'destructive' });
    expect(classes).toContain('text-destructive');
  });
});

describe('buttonVariants (hlm-button cva)', () => {
  it('combines the default variant with the default size', () => {
    const classes = buttonVariants({ variant: 'default', size: 'default' });
    expect(classes).toContain('bg-primary');
    expect(classes).toContain('text-primary-foreground');
    expect(classes).toContain('h-8');
  });

  it('combines the destructive variant with the sm size', () => {
    const classes = buttonVariants({ variant: 'destructive', size: 'sm' });
    expect(classes).toContain('text-destructive');
    expect(classes).toContain('h-7');
  });

  it('combines the outline variant with the icon size', () => {
    const classes = buttonVariants({ variant: 'outline', size: 'icon' });
    expect(classes).toContain('border-border');
    expect(classes).toContain('size-8');
  });
});

@Component({
  standalone: true,
  imports: [HlmButton, HlmInput, HlmSpinner, HlmCheckbox],
  template: `
    <button hlmBtn data-testid="btn">Click</button>
    <input hlmInput data-testid="input" />
    <hlm-spinner data-testid="spinner" />
    <hlm-checkbox data-testid="checkbox" />
  `,
})
class HelmHostComponent {}

describe('helm component render smoke tests', () => {
  function build() {
    const fixture = TestBed.createComponent(HelmHostComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('mounts button[hlmBtn]', () => {
    const fixture = build();
    expect(
      fixture.nativeElement.querySelector('[data-testid=btn]'),
    ).toBeTruthy();
    expect(fixture.debugElement.query(By.directive(HlmButton))).toBeTruthy();
  });

  it('mounts input[hlmInput]', () => {
    const fixture = build();
    expect(
      fixture.nativeElement.querySelector('[data-testid=input]'),
    ).toBeTruthy();
    expect(fixture.debugElement.query(By.directive(HlmInput))).toBeTruthy();
  });

  it('mounts hlm-spinner', () => {
    const fixture = build();
    expect(
      fixture.nativeElement.querySelector('[data-testid=spinner]'),
    ).toBeTruthy();
    expect(fixture.debugElement.query(By.directive(HlmSpinner))).toBeTruthy();
  });

  it('mounts hlm-checkbox', () => {
    const fixture = build();
    expect(
      fixture.nativeElement.querySelector('[data-testid=checkbox]'),
    ).toBeTruthy();
    expect(fixture.debugElement.query(By.directive(HlmCheckbox))).toBeTruthy();
  });
});
