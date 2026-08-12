import { Component, signal } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import type { TrnEmojiPick } from '../trn-emoji.model';
import { TrnEmojiPickerComponent } from './trn-emoji-picker.component';

/** Host so the output can be observed the way a call site sees it. */
@Component({
  imports: [TrnEmojiPickerComponent],
  template: `<trn-emoji-picker (picked)="picks.set([...picks(), $event])" />`,
})
class Host {
  readonly picks = signal<TrnEmojiPick[]>([]);
}

describe('TrnEmojiPickerComponent', () => {
  const emit = async (emoji: unknown) => {
    const { fixture } = await render(Host);
    const picker = fixture.debugElement.children[0]
      .componentInstance as TrnEmojiPickerComponent & {
      onSelect(event: unknown): void;
    };
    picker.onSelect({ emoji, $event: new Event('click') });
    return fixture.componentInstance.picks();
  };

  it('narrows a vendor selection to the three fields Trinity uses', async () => {
    const picks = await emit({
      native: '🚀',
      id: 'rocket',
      colons: ':rocket:',
      skin: 3,
      unified: '1f680',
    });

    expect(picks).toEqual([{ native: '🚀', id: 'rocket', colons: ':rocket:' }]);
  });

  // The reason this narrowing exists. A pick with no character is not insertable, and the
  // two call sites used to disagree about it BY ACCIDENT: the reaction dialog closed with
  // `null` — indistinguishable from a dismissal — while the composer silently did nothing.
  // Neither was a decision anyone made. One render per test: `render()` configures the
  // TestBed, which cannot be done twice in one case.
  it('drops a selection whose emoji has no native character', async () => {
    expect(await emit({ id: 'custom', colons: ':custom:' })).toEqual([]);
  });

  it('drops a selection with no emoji at all', async () => {
    expect(await emit(undefined)).toEqual([]);
  });

  it('is announced as a dialog and can be targeted by aria-controls', async () => {
    const { fixture } = await render(TrnEmojiPickerComponent, {
      inputs: { label: 'Pick a reaction', pickerId: 'reaction-emoji-picker' },
    });
    const host = fixture.nativeElement as HTMLElement;

    expect(host.getAttribute('role')).toBe('dialog');
    expect(host.getAttribute('aria-label')).toBe('Pick a reaction');
    // The composer's trigger carries `aria-expanded` and had nothing to point at.
    expect(host.getAttribute('id')).toBe('reaction-emoji-picker');
  });

  it('never puts the vendor dark class on the element', async () => {
    // `darkMode` is not passed, and that is load-bearing rather than an omission: the
    // vendor turns it into `.emoji-mart-dark`, ten rules at specificity (0,3,0) that our
    // token overrides would then have to outrank. Keeping it off means they only have to
    // beat `.emoji-mart` base rules. If anyone re-enables the boolean, this fails.
    const { fixture } = await render(TrnEmojiPickerComponent);
    const html = (fixture.nativeElement as HTMLElement).innerHTML;

    expect(html).not.toContain('emoji-mart-dark');
  });
});
