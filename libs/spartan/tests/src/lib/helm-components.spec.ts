import { Component } from '@angular/core';
import { By } from '@angular/platform-browser';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
// Imported straight from the owning helm libs (libs/spartan/*). These focused
// smoke tests live in `libs/spartan/tests` because it is the one project in that
// directory with a Vitest target; the helm component libs themselves are
// lint/build-only. (They used to live in the overlay library, which has since moved
// out to `libs/components/overlay` and is no longer part of the kit at all.)
import { badgeVariants } from '@trinity/helm/badge';
import { buttonVariants, HlmButton } from '@trinity/helm/button';
import { HlmCheckbox } from '@trinity/helm/checkbox';
import { HlmInput } from '@trinity/helm/input';
import { HlmRadio, HlmRadioGroup } from '@trinity/helm/radio-group';
import { HlmSpinner } from '@trinity/helm/spinner';
import { HlmTabsImports } from '@trinity/helm/tabs';
import { HlmTextarea } from '@trinity/helm/textarea';

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
  it('uses the invariant pill radius instead of Tailwind radius steps', () => {
    const classes = badgeVariants({ variant: 'default' });
    expect(classes).toContain('rounded-full');
    expect(classes).not.toMatch(/\brounded-(?:2xl|3xl|4xl)\b/u);
  });

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
  // Render the REAL helm directives/components (never mocked) — the whole point
  // of this suite is proving each one instantiates.
  function build() {
    return render(HelmHostComponent);
  }

  it('mounts button[hlmBtn]', async () => {
    const { fixture, container } = await build();
    expect(container.querySelector('[data-testid=btn]')).toBeTruthy();
    expect(fixture.debugElement.query(By.directive(HlmButton))).toBeTruthy();
  });

  it('mounts input[hlmInput]', async () => {
    const { fixture, container } = await build();
    expect(container.querySelector('[data-testid=input]')).toBeTruthy();
    expect(fixture.debugElement.query(By.directive(HlmInput))).toBeTruthy();
  });

  it('mounts hlm-spinner', async () => {
    const { fixture, container } = await build();
    expect(container.querySelector('[data-testid=spinner]')).toBeTruthy();
    expect(fixture.debugElement.query(By.directive(HlmSpinner))).toBeTruthy();
  });

  it('mounts hlm-checkbox', async () => {
    const { fixture, container } = await build();
    expect(container.querySelector('[data-testid=checkbox]')).toBeTruthy();
    expect(fixture.debugElement.query(By.directive(HlmCheckbox))).toBeTruthy();
  });
});

/**
 * `aria-describedby` on a helm form control.
 *
 * These are contract tests, not smoke tests, and they exist because the contract was broken:
 * every one of these controls composes `BrnFieldControlDescribedBy` through `hostDirectives`,
 * and that directive owns `[attr.aria-describedby]` as a host binding. A `hostDirectives` entry
 * publishes a composed directive's input ONLY if it lists it in `inputs: [...]`; where it did
 * not, the directive's binding computed `null` and removed the attribute — so a hint set by a
 * consumer never reached a screen reader, silently, whether it was written as a static attribute
 * or as a binding.
 *
 * The two shapes are asserted separately on purpose: they fail independently, and one of them
 * still does — see the `[attr.…]` case at the end.
 */
describe('aria-describedby on helm form controls', () => {
  @Component({
    imports: [HlmInput, HlmTextarea, HlmRadioGroup, HlmRadio, HlmCheckbox],
    template: `
      <input hlmInput data-testid="static" aria-describedby="hint" />
      <input hlmInput data-testid="bound" [aria-describedby]="id" />
      <textarea
        hlmTextarea
        data-testid="textarea"
        aria-describedby="hint"
      ></textarea>
      <hlm-radio-group data-testid="radio-group" aria-describedby="hint" />
      <hlm-checkbox data-testid="checkbox" aria-describedby="hint" />
    `,
  })
  class HostComponent {
    readonly id = 'hint';
  }

  const describedBy = async (testId: string) => {
    const { fixture } = await render(HostComponent);
    return fixture.debugElement
      .query(By.css(`[data-testid=${testId}]`))
      .nativeElement.getAttribute('aria-describedby');
  };

  it('survives as a static attribute on an input', async () => {
    expect(await describedBy('static')).toBe('hint');
  });

  it('survives as a binding on an input', async () => {
    expect(await describedBy('bound')).toBe('hint');
  });

  it('survives on a textarea', async () => {
    expect(await describedBy('textarea')).toBe('hint');
  });

  it('survives on a radio group', async () => {
    expect(await describedBy('radio-group')).toBe('hint');
  });

  it('is NOT rescued in the [attr.…] form — a known limitation', async () => {
    // Exposing the input fixes the static and bound forms but not this one: the composed
    // directive's host binding runs after the template's attribute binding and overwrites it.
    // Pinned rather than left to prose so that if a future Angular or brain release changes
    // it, this fails and the rule in the developer UI and theming guide gets revisited.
    @Component({
      imports: [HlmInput],
      template: `<input
        hlmInput
        data-testid="attr"
        [attr.aria-describedby]="id"
      />`,
    })
    class AttrHostComponent {
      readonly id = 'hint';
    }

    const { fixture } = await render(AttrHostComponent);

    expect(
      fixture.debugElement
        .query(By.css('[data-testid=attr]'))
        .nativeElement.getAttribute('aria-describedby'),
    ).toBeNull();
  });

  it('is still forwarded, not kept, on a checkbox', async () => {
    // The deliberate asymmetry. `hlm-checkbox` declares its own `aria-describedby` input and
    // forwards it to the inner `<brn-checkbox>`, nulling the host attribute on purpose — the
    // host is `display: contents` and is not the focusable control. Pinned so a later sweep
    // over `hostDirectives` does not "fix" it into describing the wrong element.
    expect(await describedBy('checkbox')).toBeNull();
  });
});

describe('the tabs kit, minus the piece that was deleted', () => {
  it('ships the five tab directives and no paginated list', () => {
    // A registered divergence: `@spartan-ng/cli` generates `hlm-tabs-paginated-list.ts` — a
    // scrolling trigger row for a tab set too wide to fit — and it was deleted here. Nothing
    // wraps it, and it dragged `@angular/cdk/observers`, `@ng-icons/*` and the button lib in
    // behind it. A re-sync restores it silently, which is what this fails on: the choice
    // should be re-made deliberately, not inherited from a generator run.
    expect(HlmTabsImports.map((directive) => directive.name).sort()).toEqual([
      'HlmTabs',
      'HlmTabsContent',
      'HlmTabsContentLazy',
      'HlmTabsList',
      'HlmTabsTrigger',
    ]);
  });
});
