import { ApplicationRef, Component } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { CdkMenuTrigger, MENU_AIM } from '@angular/cdk/menu';
import { type ConnectedPosition } from '@angular/cdk/overlay';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
// Imported straight from the owning helm lib (libs/spartan/dropdown-menu). Like the
// other helm smoke tests, this lives in the overlay lib because it is the one spartan
// lib with a working Vitest target; the helm component libs are lint/build-only.
import {
  HlmDropdownMenu,
  HlmDropdownMenuItem,
  HlmDropdownMenuSub,
  HlmDropdownMenuSubTrigger,
  HlmDropdownMenuTrigger,
} from '@trinity/helm/dropdown-menu';

// Regression guard for the zoneless submenu fix in HlmDropdownMenuSubTrigger.
//
// A submenu trigger opens its submenu on hover; CDK's own click handler then calls
// toggle(), which *closes* an already-open submenu. Under zone.js the overlay attach
// was deferred enough that a click usually still opened the submenu, but under
// provideZonelessChangeDetection() the attach is synchronous, so the click closes it.
// The fix shadows CDK's _handleClick so a sub-trigger click open()s (idempotently)
// instead of toggling — matching radix/shadcn semantics. This test pins that behaviour
// without a browser: a second click on the sub-trigger must keep the submenu open
// (CDK's default toggle() would close it on the second click).
@Component({
  selector: 'trn-submenu-host',
  imports: [
    HlmDropdownMenuTrigger,
    HlmDropdownMenu,
    HlmDropdownMenuItem,
    HlmDropdownMenuSubTrigger,
    HlmDropdownMenuSub,
  ],
  template: `
    <button [hlmDropdownMenuTrigger]="menu" data-testid="root-trigger">
      Open
    </button>
    <ng-template #menu>
      <div hlmDropdownMenu>
        <button
          hlmDropdownMenuItem
          [hlmDropdownMenuSubTrigger]="sub"
          data-testid="sub-trigger"
        >
          More
        </button>
      </div>
    </ng-template>
    <ng-template #sub>
      <div hlmDropdownMenuSub>
        <button hlmDropdownMenuItem data-testid="sub-item">Deep item</button>
      </div>
    </ng-template>
  `,
})
class SubmenuHost {}

// CDK menu overlays are root views attached to ApplicationRef, not the fixture view,
// so a full tick() is what renders their content under zoneless change detection.
function flush(): void {
  TestBed.inject(ApplicationRef).tick();
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

describe('HlmDropdownMenuSubTrigger — submenu open semantics', () => {
  it('opens the submenu on click and keeps it open on a second click (never toggles closed)', async () => {
    await render(SubmenuHost);

    (byTestId('root-trigger') as HTMLElement).click();
    flush();

    const subTrigger = byTestId('sub-trigger');
    expect(subTrigger).not.toBeNull();

    // First click opens the submenu.
    subTrigger!.click();
    flush();
    expect(byTestId('sub-item')).not.toBeNull();

    // A second click must NOT close it — CDK's default toggle() would, which is the
    // zoneless regression this guards against.
    subTrigger!.click();
    flush();
    expect(byTestId('sub-item')).not.toBeNull();
  });
});

/**
 * A sub-trigger and a root trigger mounted directly (not inside an `ng-template`), so the
 * directives are reachable through the fixture rather than through a CDK overlay. This test
 * is about the position list a trigger *hands to* CDK, which is decided at construction and
 * needs no menu to be open.
 */
@Component({
  selector: 'trn-trigger-host',
  imports: [HlmDropdownMenuTrigger, HlmDropdownMenu, HlmDropdownMenuSubTrigger],
  template: `
    <button [hlmDropdownMenuSubTrigger]="empty" data-testid="sub"></button>
    <button
      [hlmDropdownMenuSubTrigger]="empty"
      side="bottom"
      data-testid="sub-forced"
    ></button>
    <button [hlmDropdownMenuTrigger]="empty" data-testid="root"></button>
    <ng-template #empty><div hlmDropdownMenu></div></ng-template>
  `,
})
class TriggerHost {}

/** The `menuPosition` the directive on `testid` assigned to its host CdkMenuTrigger. */
function positionsFor(
  fixture: ComponentFixture<TriggerHost>,
  testid: string,
): ConnectedPosition[] {
  const el = fixture.debugElement.query(By.css(`[data-testid="${testid}"]`));
  return el.injector.get(CdkMenuTrigger).menuPosition as ConnectedPosition[];
}

// Issue #28. Upstream defaults a sub-trigger's `side` to the ROOT-menu config ('bottom'), which
// positions a submenu below/above its trigger — inside the parent menu's own rectangle, so it
// covers the menu that spawned it. jsdom reports every rect as 0x0, so geometry itself is
// untestable here; the position list handed to CDK is the real input and is what these pin.
describe('HlmDropdownMenuSubTrigger — submenu placement', () => {
  it('places a submenu beside its trigger, never above or below it', async () => {
    const { fixture } = await render(TriggerHost);

    expect(positionsFor(fixture, 'sub')).toEqual([
      { originX: 'end', originY: 'top', overlayX: 'start', overlayY: 'top' },
      { originX: 'start', originY: 'top', overlayX: 'end', overlayY: 'top' },
    ]);
  });

  // The invariant behind the literals above: a purely horizontal placement can never overlap
  // the parent, whichever fallback CDK picks. Stated separately so the reason survives an
  // upstream change to the exact list.
  it('offers only horizontal placements, so no fallback can cover the parent', async () => {
    const { fixture } = await render(TriggerHost);

    for (const position of positionsFor(fixture, 'sub')) {
      expect(position.originY).toBe(position.overlayY);
      expect(position.originX).not.toBe(position.overlayX);
    }
  });

  it('still honours an explicit side, so the default is an override and not a lock', async () => {
    const { fixture } = await render(TriggerHost);

    expect(positionsFor(fixture, 'sub-forced')).toEqual([
      {
        originX: 'start',
        originY: 'bottom',
        overlayX: 'start',
        overlayY: 'top',
      },
      {
        originX: 'start',
        originY: 'top',
        overlayX: 'start',
        overlayY: 'bottom',
      },
    ]);
  });

  // A root dropdown SHOULD open below its trigger — the override is scoped to submenus.
  it('leaves a root trigger opening below its trigger', async () => {
    const { fixture } = await render(TriggerHost);

    expect(positionsFor(fixture, 'root')).toEqual([
      {
        originX: 'start',
        originY: 'bottom',
        overlayX: 'start',
        overlayY: 'top',
      },
      {
        originX: 'start',
        originY: 'top',
        overlayX: 'start',
        overlayY: 'bottom',
      },
    ]);
  });
});

/** A menu container mounted directly, so its element injector is reachable. */
@Component({
  selector: 'trn-aim-host',
  imports: [HlmDropdownMenu],
  template: `<div hlmDropdownMenu data-testid="menu"></div>`,
})
class AimHost {}

// Issue #28, second half. Now that submenus open BESIDE their parent, the pointer has to
// travel across the rows between the trigger and the row it is aiming at — and CDK closes an
// open submenu on entering any non-trigger sibling *unless* a MENU_AIM is provided, which
// upstream Helm does not do. Measured in a browser: without this the submenu closes mid-travel.
// jsdom cannot model pointer trajectory, so this pins the provider instead.
describe('HlmDropdownMenu — menu aim', () => {
  it('provides a MENU_AIM so travelling into a submenu does not close it', async () => {
    const { fixture } = await render(AimHost);

    const menu = fixture.debugElement.query(By.css('[data-testid="menu"]'));
    expect(menu.injector.get(MENU_AIM, null)).not.toBeNull();
  });
});
