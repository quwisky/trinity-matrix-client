import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnToggleGroupComponent } from './trn-toggle-group.component';
import { TrnToggleGroupItemDirective } from './trn-toggle-group-item.directive';

/**
 * The keyboard is the whole reason this wrapper exists.
 *
 * `BrnToggleGroup` underneath is a value holder with no keydown handling at all, so a bar
 * built straight on it puts one tab stop per button. What is pinned here is the roving
 * tabindex and the arrow mapping — selection stays the kit's, and is not this file's to
 * assert.
 */
@Component({
  imports: [TrnToggleGroupComponent, TrnToggleGroupItemDirective],
  template: `
    <trn-toggle-group type="multiple" [orientation]="orientation()">
      <button trnToggleGroupItem value="bold" data-t="bold">B</button>
      <button
        trnToggleGroupItem
        value="italic"
        data-t="italic"
        [disabled]="italicOff()"
      >
        I
      </button>
      <button trnToggleGroupItem value="code" data-t="code">C</button>
    </trn-toggle-group>
  `,
})
class HostComponent {
  readonly orientation = signal<'horizontal' | 'vertical'>('horizontal');
  readonly italicOff = signal(false);
}

async function build() {
  const { container, fixture } = await render(HostComponent);
  const host = fixture.componentInstance;
  TestBed.tick();
  const group = container.querySelector('trn-toggle-group') as HTMLElement;
  const button = (name: string) =>
    container.querySelector<HTMLButtonElement>(`[data-t="${name}"]`)!;
  const press = (key: string) =>
    group.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  return { container, group, host, button, press };
}

/** Which buttons a Tab press could reach. */
const tabbable = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[trnToggleGroupItem]')]
    .filter((el) => el.tabIndex === 0)
    .map((el) => el.dataset['t']);

describe('TrnToggleGroupComponent', () => {
  it('is a toolbar, and says which way its arrows run', async () => {
    const { group } = await build();

    // `role="group"` is what the kit contributes, and it does not promise arrow keys.
    expect(group.getAttribute('role')).toBe('toolbar');
    expect(group.getAttribute('aria-orientation')).toBe('horizontal');
  });

  it('offers exactly one tab stop, before anyone has pressed a key', async () => {
    // The point of a toolbar: nine formatting buttons must cost one Tab, not nine.
    const { container } = await build();

    expect(tabbable(container)).toEqual(['bold']);
  });

  it('moves focus and the tab stop together, and wraps', async () => {
    const { container, button, press } = await build();
    button('bold').focus();

    press('ArrowRight');
    expect(document.activeElement).toBe(button('italic'));
    expect(tabbable(container)).toEqual(['italic']);

    press('ArrowRight');
    press('ArrowRight');
    // Past the last: a toolbar wraps rather than stopping dead.
    expect(document.activeElement).toBe(button('bold'));

    press('ArrowLeft');
    expect(document.activeElement).toBe(button('code'));
  });

  it('goes to the ends with Home and End', async () => {
    const { button, press } = await build();
    button('italic').focus();

    press('End');
    expect(document.activeElement).toBe(button('code'));

    press('Home');
    expect(document.activeElement).toBe(button('bold'));
  });

  it('steps over a disabled button rather than focusing it', async () => {
    // Focused-and-inert is the worse failure: the user arrows onto a control, presses it,
    // and nothing happens.
    const { host, button, press } = await build();
    host.italicOff.set(true);
    TestBed.tick();
    button('bold').focus();

    press('ArrowRight');

    expect(document.activeElement).toBe(button('code'));
  });

  it('reads the arrows off the orientation it was given', async () => {
    // A vertical bar answers Up/Down; horizontal arrows are somebody else's to handle.
    const { group, host, button, press } = await build();
    host.orientation.set('vertical');
    TestBed.tick();
    button('bold').focus();

    press('ArrowRight');
    expect(document.activeElement).toBe(button('bold')); // untouched

    press('ArrowDown');
    expect(document.activeElement).toBe(button('italic'));
    expect(group.getAttribute('aria-orientation')).toBe('vertical');
  });

  it('leaves a key it does not handle alone', async () => {
    const { button, press } = await build();
    button('bold').focus();

    press('a');

    expect(document.activeElement).toBe(button('bold'));
  });
});
