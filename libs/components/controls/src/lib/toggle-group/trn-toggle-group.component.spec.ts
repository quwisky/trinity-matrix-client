import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import {
  normalizeTrnTogglePresentation,
  normalizeTrnToggleSize,
  normalizeTrnToggleVariant,
} from '../toggle/trn-toggle-recipe';
import { TrnToggleGroupComponent } from './trn-toggle-group.component';
import { TrnToggleGroupItemDirective } from './trn-toggle-group-item.directive';

/**
 * The keyboard is the whole reason this wrapper exists.
 *
 * `BrnToggleGroup` underneath is a value holder with no keydown handling at all, so a bar
 * built straight on it puts one tab stop per button. What is pinned here is the roving
 * tabindex and the arrow mapping — selection stays Brain's, and is not this file's to
 * assert.
 */
@Component({
  imports: [TrnToggleGroupComponent, TrnToggleGroupItemDirective],
  template: `
    <trn-toggle-group
      type="multiple"
      variant="accent"
      presentation="outline"
      size="sm"
      arrangement="joined"
      [orientation]="orientation()"
      [value]="value()"
      (valueChange)="seen.push($event)"
    >
      @if (showBold()) {
        <button trnToggleGroupItem value="bold" data-t="bold">B</button>
      }
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
  readonly showBold = signal(true);
  readonly value = signal<string[]>([]);
  readonly seen: string[][] = [];
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
  it('normalizes the group values accepted by the former public wrapper', () => {
    expect(normalizeTrnToggleVariant('default')).toBe('neutral');
    expect(normalizeTrnToggleVariant('outline')).toBe('neutral');
    expect(normalizeTrnTogglePresentation('outline', 'plain')).toBe('outline');
    expect(normalizeTrnToggleSize('default')).toBe('md');
  });

  it('publishes canonical recipe state without exposing the Helm spelling', async () => {
    const { group, button } = await build();

    expect(group.getAttribute('data-trn-variant')).toBe('accent');
    expect(group.getAttribute('data-trn-size')).toBe('sm');
    expect(group.getAttribute('data-trn-presentation')).toBe('outline');
    expect(group.getAttribute('data-trn-arrangement')).toBe('joined');
    expect(button('bold').hasAttribute('data-trn-toggle')).toBe(true);
    expect(group.hasAttribute('data-slot')).toBe(false);
    expect(group.hasAttribute('data-spacing')).toBe(false);
    expect(button('bold').hasAttribute('data-slot')).toBe(false);
    expect(button('bold').className).not.toContain('focus-visible:ring-[3px]');
  });

  it('is a toolbar, and says which way its arrows run', async () => {
    const { group } = await build();

    // `role="group"` is what Brain contributes, and it does not promise arrow keys.
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

  it('carries selection through both layers of hostDirectives', async () => {
    // The mechanism the whole wrapper rests on, and the one that fails at RUNTIME rather
    // than at compile time: `type`, `value` and `valueChange` are published onto this host by
    // BrnToggleGroup, and a wrong `hostDirectives` list leaves them
    // silently inert while `tsc` stays green.
    const { host, button } = await build();

    host.value.set(['bold']);
    TestBed.tick();
    expect(button('bold').getAttribute('aria-pressed')).toBe('true');
    expect(button('code').getAttribute('aria-pressed')).toBe('false');

    button('code').click();
    TestBed.tick();

    expect(host.seen.at(-1)).toEqual(['bold', 'code']);
  });

  it('lays out the way it announces itself', async () => {
    // The recipe layout and accessibility announcement must consume the same orientation;
    // otherwise the arrows can follow one axis while the bar is drawn along the other.
    const { group, host } = await build();
    expect(group.getAttribute('data-orientation')).toBe('horizontal');

    host.orientation.set('vertical');
    TestBed.tick();

    expect(group.getAttribute('data-orientation')).toBe('vertical');
    expect(group.getAttribute('aria-orientation')).toBe('vertical');
  });

  it('keeps a tab stop when the item holding it is removed', async () => {
    // A contextual bar's buttons live behind `@if`, so the set changes while the group is
    // alive. Seeding once left every button at -1 and the whole toolbar unreachable by Tab.
    const { container, host } = await build();
    expect(tabbable(container)).toEqual(['bold']);

    host.showBold.set(false);
    TestBed.tick();

    expect(tabbable(container)).toEqual(['italic']);
  });

  it('keeps a tab stop when the item holding it is disabled in place', async () => {
    // The same dead end by the other route: the holder stays in the set, the browser stops
    // focusing it, and its `tabIndex` of 0 says otherwise.
    const { container, host } = await build();
    host.showBold.set(false);
    TestBed.tick();
    expect(tabbable(container)).toEqual(['italic']);

    host.italicOff.set(true);
    TestBed.tick();
    await Promise.resolve(); // MutationObserver callbacks are a microtask behind the write

    expect(tabbable(container)).toEqual(['code']);
  });

  it('leaves a key it does not handle alone', async () => {
    const { button, press } = await build();
    button('bold').focus();

    press('a');

    expect(document.activeElement).toBe(button('bold'));
  });
});
