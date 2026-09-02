import { Component, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import {
  TrnDropdownMenu,
  TrnDropdownMenuCheckbox,
  TrnDropdownMenuItem,
  TrnDropdownMenuTrigger,
} from './trn-dropdown-menu';
import { trnDropdownMenuItemRecipe } from './trn-dropdown-menu-recipe';

@Component({
  imports: [
    TrnDropdownMenu,
    TrnDropdownMenuCheckbox,
    TrnDropdownMenuItem,
    TrnDropdownMenuTrigger,
  ],
  template: `
    <button [trnDropdownMenuTrigger]="menu">Open</button>
    <ng-template #menu>
      <div trnDropdownMenu>
        <button
          trnDropdownMenuItem
          data-testid="neutral-item"
          (triggered)="chosen = chosen + 1"
        >
          Choose
        </button>
        <button trnDropdownMenuItem variant="danger" data-testid="danger-item">
          Delete
        </button>
        <button
          trnDropdownMenuItem
          variant="destructive"
          data-testid="legacy-danger-item"
        >
          Legacy delete
        </button>
        <button trnDropdownMenuItem disabled data-testid="disabled-item">
          Disabled
        </button>
        <button
          trnDropdownMenuCheckbox
          checked
          disabled
          lockedSelection
          data-testid="locked-selection"
        >
          Always included
        </button>
        <button
          trnDropdownMenuCheckbox
          checked
          data-testid="removable-selection"
        >
          Optional
        </button>
      </div>
    </ng-template>
  `,
})
class HostComponent {
  readonly trigger = viewChild.required(TrnDropdownMenuTrigger);
  chosen = 0;
}

describe('Trinity dropdown menu', () => {
  it('forwards trigger, menu, item and selection behavior', async () => {
    const { fixture, container } = await render(HostComponent);
    container.querySelector<HTMLButtonElement>('button')?.click();
    TestBed.tick();

    const item = document.querySelector<HTMLButtonElement>(
      '[trnDropdownMenuItem]',
    );
    expect(item).not.toBeNull();
    item?.click();
    TestBed.tick();

    expect(fixture.componentInstance.chosen).toBe(1);
  });

  it('opens programmatically through the Trinity trigger API', async () => {
    const { fixture } = await render(HostComponent);

    fixture.componentInstance.trigger().open();
    TestBed.tick();

    expect(document.querySelector('[trnDropdownMenuItem]')).not.toBeNull();
  });

  it('normalizes canonical and temporary item appearances without changing disabled behavior', async () => {
    const { fixture } = await render(HostComponent);

    fixture.componentInstance.trigger().open();
    TestBed.tick();

    const canonical = document.querySelector<HTMLElement>(
      '[data-testid=danger-item]',
    );
    const legacy = document.querySelector<HTMLElement>(
      '[data-testid=legacy-danger-item]',
    );
    const disabled = document.querySelector<HTMLButtonElement>(
      '[data-testid=disabled-item]',
    );

    expect(canonical?.dataset['trnVariant']).toBe('danger');
    expect(legacy?.dataset['trnVariant']).toBe('danger');
    expect(trnDropdownMenuItemRecipe('danger')).toContain('text-danger');
    expect(disabled?.getAttribute('data-disabled')).not.toBeNull();
  });

  it('publishes locked checked selections as a distinct disabled state', async () => {
    const { fixture } = await render(HostComponent);

    fixture.componentInstance.trigger().open();
    TestBed.tick();

    const locked = document.querySelector<HTMLButtonElement>(
      '[data-testid=locked-selection]',
    );
    const removable = document.querySelector<HTMLButtonElement>(
      '[data-testid=removable-selection]',
    );
    expect(locked?.getAttribute('data-disabled')).not.toBeNull();
    expect(locked?.getAttribute('data-checked')).not.toBeNull();
    expect(locked?.getAttribute('data-trn-selection-locked')).toBe('');
    expect(removable?.getAttribute('data-trn-selection-locked')).toBeNull();
  });
});
