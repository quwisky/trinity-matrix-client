import { ApplicationRef, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
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
