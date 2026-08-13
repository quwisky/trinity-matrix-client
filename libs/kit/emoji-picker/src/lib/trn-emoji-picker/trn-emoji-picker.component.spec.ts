import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Component, signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { PickerComponent } from '@ctrl/ngx-emoji-mart';
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
  /**
   * Fires the VENDOR's own output rather than calling our handler.
   *
   * Reaching for the protected `onSelect` directly left the `(emojiSelect)` binding
   * uncovered: deleting it from the template kept every test in this file green while the
   * picker emitted nothing at all. Going through `PickerComponent` covers the binding and
   * the narrowing in one path, so breaking either fails here.
   */
  const emit = async (emoji: unknown) => {
    const { fixture } = await render(Host);
    const vendor = fixture.debugElement.query(By.directive(PickerComponent));
    vendor.componentInstance.emojiSelect.emit({
      emoji,
      $event: new Event('click'),
    });
    fixture.detectChanges();
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

  it('can be targeted by aria-controls, and claims no role of its own', async () => {
    const { fixture } = await render(TrnEmojiPickerComponent, {
      inputs: { pickerId: 'reaction-emoji-picker' },
    });
    const host = fixture.nativeElement as HTMLElement;

    // The composer's trigger carries `aria-expanded` and had nothing to point at.
    expect(host.getAttribute('id')).toBe('reaction-emoji-picker');

    // Deliberately roleless. In the reaction flow this sits inside a CDK dialog container
    // that already has `role="dialog"` — a role here nests one dialog in another — and in
    // the composer it is a non-modal inline panel with no focus trap, where `dialog`
    // promises focus management that does not exist. Naming belongs to the CDK container
    // or to the trigger, not here.
    expect(host.getAttribute('role')).toBeNull();
    expect(host.getAttribute('aria-label')).toBeNull();
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

  it('keeps every unencapsulated rule inside the host class', () => {
    // `ViewEncapsulation.None` means these rules are global the moment they load. A rule
    // that forgot the `.trn-emoji-picker` prefix would restyle `.emoji-mart` anywhere —
    // and, being a stylesheet, would do it silently: jsdom applies no CSS, so no rendering
    // test could catch it. Asserted on the source instead.
    const sheet = readFileSync(
      join(import.meta.dirname, 'trn-emoji-picker.component.scss'),
      'utf8',
    );
    const topLevel = sheet
      .split('\n')
      .filter((line) => /^[.&#a-z\[]/i.test(line) && line.includes('{'));

    expect(topLevel).not.toEqual([]);
    expect(
      topLevel.filter((line) => !line.startsWith('.trn-emoji-picker')),
    ).toEqual([]);
  });
});
