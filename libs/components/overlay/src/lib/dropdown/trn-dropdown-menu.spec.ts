import { Component, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import {
  TrnDropdownMenu,
  TrnDropdownMenuItem,
  TrnDropdownMenuTrigger,
} from './trn-dropdown-menu';

@Component({
  imports: [TrnDropdownMenu, TrnDropdownMenuItem, TrnDropdownMenuTrigger],
  template: `
    <button [trnDropdownMenuTrigger]="menu">Open</button>
    <ng-template #menu>
      <div trnDropdownMenu>
        <button trnDropdownMenuItem (triggered)="chosen = chosen + 1">
          Choose
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
});
