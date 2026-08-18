import type { DebugElement } from '@angular/core';
import { By } from '@angular/platform-browser';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { TrnCheckboxComponent } from '@trinity/components/checkbox';
import {
  KeywordRulesService,
  KeywordValidationError,
  type KeywordRule,
} from '@trinity/data-access/notifications';
import { TrnToastService } from '@trinity/components/overlay';
import { KeywordRulesBlockComponent } from './keyword-rules-block.component';

const LOUD: KeywordRule = {
  ruleId: 'oncall',
  pattern: 'oncall',
  enabled: true,
  sound: true,
  soundValue: 'default',
};
const QUIET: KeywordRule = {
  ruleId: 'trinity',
  pattern: 'trinity',
  enabled: true,
  sound: false,
  soundValue: 'default',
};
const OFF: KeywordRule = {
  ruleId: 'standby',
  pattern: 'standby',
  enabled: false,
  sound: true,
  soundValue: 'default',
};

async function build(
  over: {
    keywords?: KeywordRule[][];
    hasLoaded?: boolean;
    add?: Mock;
    remove?: Mock;
    setSound?: Mock;
    find?: Mock;
  } = {},
) {
  // `keywords` is a queue of successive reads, so a test can model the list changing
  // after a write — which is how the real service behaves once it re-reads the rules.
  const reads = over.keywords ?? [[LOUD, QUIET]];
  let read = 0;
  const keywords = vi.fn(() => reads[Math.min(read++, reads.length - 1)]);
  const add = over.add ?? vi.fn(() => of(undefined));
  const remove = over.remove ?? vi.fn(() => of(undefined));
  const setSound = over.setSound ?? vi.fn(() => of(undefined));
  const find = over.find ?? vi.fn(() => undefined);
  const toastShow = vi.fn();
  const { fixture } = await render(KeywordRulesBlockComponent, {
    providers: [
      MockProvider(KeywordRulesService, {
        keywords,
        hasLoaded: () => over.hasLoaded ?? true,
        add,
        remove,
        setSound,
        find,
      }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return {
    cmp: fixture.componentInstance,
    fixture,
    keywords,
    add,
    remove,
    setSound,
    toastShow,
  };
}

const text = (fixture: { nativeElement: HTMLElement }) =>
  fixture.nativeElement.textContent ?? '';

const rows = (fixture: { nativeElement: HTMLElement }) =>
  fixture.nativeElement.querySelectorAll('[data-testid="keyword-row"]');

/** The rendered checkbox instances, so a test asserts pixels rather than the model. */
const checkboxes = (fixture: {
  debugElement: DebugElement;
}): { componentInstance: TrnCheckboxComponent }[] =>
  fixture.debugElement.queryAll(By.directive(TrnCheckboxComponent));

describe('KeywordRulesBlockComponent', () => {
  it('lists the account’s keywords', async () => {
    const { fixture } = await build();

    expect(rows(fixture)).toHaveLength(2);
    expect(text(fixture)).toContain('oncall');
    expect(text(fixture)).toContain('trinity');
  });

  it('says a muted room stays muted, because users expect the opposite', async () => {
    // Content rules are evaluated below overrides, so a room mute wins. Every other
    // app users come from lets a keyword pierce a mute, so this has to be stated.
    const { fixture } = await build();

    expect(text(fixture)).toContain('muted room stays muted');
  });

  it('says it is loading before the rules have synced', async () => {
    // The gap this closes: with no loading branch the @else rendered an empty <ul>, so a
    // cold load showed the heading, the blurb and the input with nothing between them and
    // no explanation — and nothing re-reads, so it stayed that way.
    const { fixture } = await build({ keywords: [[]], hasLoaded: false });

    expect(text(fixture)).toContain('Loading your keywords');
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="keyword-add"]',
      ),
    ).toHaveProperty('disabled', true); // nothing may be written against an unread list
  });

  it('shows an empty state once the rules have actually loaded', async () => {
    const { fixture } = await build({ keywords: [[]], hasLoaded: true });

    expect(text(fixture)).toContain('no keywords yet');
  });

  it('does not claim "no keywords" before the rules have synced', async () => {
    // An empty list before the first sync is an absence of data, not a fact about
    // the account — asserting it invites the user to re-add keywords they still have.
    const { fixture } = await build({ keywords: [[]], hasLoaded: false });

    expect(text(fixture)).not.toContain('no keywords yet');
    expect(rows(fixture)).toHaveLength(0);
  });

  it('marks a keyword another client switched off', async () => {
    const { fixture } = await build({ keywords: [[OFF]] });

    expect(
      fixture.nativeElement.querySelector('[data-testid="keyword-off"]'),
    ).not.toBeNull();
  });

  it('adds the typed word and clears the field', async () => {
    const { cmp, fixture, add } = await build({ keywords: [[], [LOUD]] });

    cmp.keywordForm.word().value.set('oncall');
    cmp.add();
    fixture.detectChanges();

    expect(add).toHaveBeenCalledWith('oncall');
    expect(cmp.keywordForm.word().value()).toBe('');
    expect(rows(fixture)).toHaveLength(1); // re-read after the write
  });

  it('trims what was typed', async () => {
    const { cmp, add } = await build({ keywords: [[]] });

    cmp.keywordForm.word().value.set('  oncall  ');
    cmp.add();

    expect(add).toHaveBeenCalledWith('oncall');
  });

  it('does nothing when the field is empty', async () => {
    const { cmp, add, toastShow } = await build({ keywords: [[]] });

    cmp.keywordForm.word().value.set('   ');
    cmp.add();

    expect(add).not.toHaveBeenCalled();
    expect(toastShow).not.toHaveBeenCalled(); // nothing typed is not an error
  });

  it('refuses an exact repeat of an active keyword', async () => {
    const { cmp, add, toastShow } = await build({ find: vi.fn(() => LOUD) });

    cmp.keywordForm.word().value.set('oncall');
    cmp.add();

    expect(add).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('already in your keywords'),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('lets a differently-cased keyword through, so casing can be fixed', async () => {
    // The service re-points the existing rule rather than duplicating it; refusing this
    // as a duplicate left someone unable to fix their own keyword's casing except by
    // removing it and adding it again.
    const { cmp, add, toastShow } = await build({ find: vi.fn(() => LOUD) });

    cmp.keywordForm.word().value.set('OnCall');
    cmp.add();

    expect(add).toHaveBeenCalledWith('OnCall');
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('lets a switched-off keyword be re-added, which is what switches it back on', async () => {
    // Refusing this as a duplicate would leave the keyword permanently inert, with
    // nothing in the UI to say why or how to fix it.
    const { cmp, add, toastShow } = await build({ find: vi.fn(() => OFF) });

    cmp.keywordForm.word().value.set('standby');
    cmp.add();

    expect(add).toHaveBeenCalledWith('standby');
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('ignores a second Enter while the first add is still in flight', async () => {
    // Both writes would otherwise race the same rule id, and the service's own
    // duplicate check cannot help — its cache is not refreshed until the first resolves.
    const { cmp, add } = await build({
      keywords: [[]],
      add: vi.fn(() => new Subject<void>()),
    });

    cmp.keywordForm.word().value.set('oncall');
    cmp.add();
    cmp.add();

    expect(add).toHaveBeenCalledTimes(1);
  });

  it('keeps the typed word and re-reads when the add fails', async () => {
    // The write may have half-applied — rule created, enable or re-read failed — so
    // assuming the list is unchanged would show "no keywords" for one that is live.
    const { cmp, keywords, toastShow } = await build({
      add: vi.fn(() => throwError(() => new Error('nope'))),
    });

    cmp.keywordForm.word().value.set('oncall');
    cmp.add();

    expect(cmp.keywordForm.word().value()).toBe('oncall');
    expect(keywords).toHaveBeenCalledTimes(2); // seed + error reload
    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('Could not add'),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('surfaces the service’s own message, so a rejected glob explains itself', async () => {
    const { cmp, toastShow } = await build({
      add: vi.fn(() =>
        throwError(
          () =>
            new KeywordValidationError('A keyword cannot contain “*” or “?”.'),
        ),
      ),
    });

    cmp.keywordForm.word().value.set('proj*');
    cmp.add();

    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('cannot contain'),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('removes a keyword by its rule id and re-reads the list', async () => {
    const { cmp, fixture, remove } = await build({
      keywords: [[LOUD, QUIET], [QUIET]],
    });

    cmp.remove(LOUD);
    fixture.detectChanges();

    expect(remove).toHaveBeenCalledWith('oncall');
    expect(rows(fixture)).toHaveLength(1);
  });

  it('toasts and keeps the row when a remove fails', async () => {
    const { cmp, fixture, toastShow } = await build({
      remove: vi.fn(() => throwError(() => new Error('nope'))),
    });

    cmp.remove(LOUD);
    fixture.detectChanges();

    expect(rows(fixture)).toHaveLength(2);
    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('Could not remove'),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('turns a keyword’s sound off without touching the keyword', async () => {
    const { cmp, setSound, remove } = await build();

    cmp.toggleSound(LOUD, false);

    expect(setSound).toHaveBeenCalledWith('oncall', false);
    expect(remove).not.toHaveBeenCalled();
  });

  it('puts the RENDERED checkbox back when the write fails', async () => {
    // The bug this exists for: TrnCheckboxComponent flips itself on click and holds that in a
    // linkedSignal over its `checked` INPUT, which only recomputes when the input
    // changes. Re-reading the unchanged server value therefore cannot un-flip it — the
    // binding has to genuinely transition. Asserting the component's model instead of
    // the rendered control passes on exactly that broken behaviour.
    //
    // The failure arrives asynchronously, as a rejected request does. That matters: a
    // synchronous error would set the optimistic value and put it back within one turn,
    // so Angular would never see the input move.
    const pending = new Subject<void>();
    const { cmp, fixture } = await build({
      keywords: [[LOUD, QUIET]],
      setSound: vi.fn(() => pending),
    });
    const box = () => checkboxes(fixture)[0].componentInstance;
    expect(box().checked()).toBe(true);

    // `toggleSound` IS the real interaction — it is what the checkbox's own
    // `(checkedChange)` calls. The wrapper's `checked` mirrors the parent's state rather
    // than keeping an optimistic copy of its own, so there is nothing to flip by hand.
    cmp.toggleSound(LOUD, false);
    fixture.detectChanges();
    expect(box().checked()).toBe(false); // held while the write is in flight

    pending.error(new Error('nope'));
    fixture.detectChanges();

    expect(box().checked()).toBe(true); // back to what the account actually holds
  });

  it('holds the new sound state while the write is in flight', async () => {
    const { cmp, fixture } = await build({
      keywords: [[LOUD, QUIET]],
      setSound: vi.fn(() => new Subject<void>()),
    });

    cmp.toggleSound(LOUD, false);
    fixture.detectChanges();

    // Still in flight, so the row must NOT be rebuilt out from under the click.
    expect(checkboxes(fixture)[0].componentInstance.checked()).toBe(false);
  });

  it('labels each row’s controls with the keyword they act on', async () => {
    // Five rows of "Sound, checkbox" and "Remove, button" are indistinguishable to a
    // screen reader, and removing the wrong keyword is one keystroke with no undo.
    const { fixture } = await build();
    const el = fixture.nativeElement as HTMLElement;

    expect(
      el
        .querySelector('[data-testid="keyword-remove"]')
        ?.getAttribute('aria-label'),
    ).toBe('Remove keyword oncall');
    // TrnCheckboxComponent nulls its own host aria-label by design and forwards an input to the
    // inner control, so the label is asserted wherever it actually lands in the row.
    expect(
      el.querySelector('[aria-label="Play a sound for oncall"]'),
    ).not.toBeNull();
  });

  describe('the rendered controls, not just the methods', () => {
    // Every test above calls the component's methods directly, so the template's
    // bindings — the only thing a user can actually reach — were entirely unpinned.
    const el = (fixture: { nativeElement: HTMLElement }) =>
      fixture.nativeElement as HTMLElement;

    /** BrnCheckbox renders the interactive control as a button inside the host. */
    const soundControls = (fixture: { nativeElement: HTMLElement }) =>
      el(fixture).querySelectorAll<HTMLButtonElement>(
        '[data-testid="keyword-sound"] button',
      );
    const removeButtons = (fixture: { nativeElement: HTMLElement }) =>
      el(fixture).querySelectorAll<HTMLButtonElement>(
        '[data-testid="keyword-remove"]',
      );
    const addButton = (fixture: { nativeElement: HTMLElement }) =>
      el(fixture).querySelector<HTMLButtonElement>(
        '[data-testid="keyword-add"]',
      );

    it('clicking the SECOND row’s Sound turns that keyword’s sound on', async () => {
      // The second row deliberately: its stored sound is false, so the assertion is
      // sensitive to the [checked] binding as well as to the output wiring, and a
      // hardcoded `false` or an inverted `$event` both fail.
      const { fixture, setSound } = await build();

      soundControls(fixture)[1].click();
      fixture.detectChanges();

      expect(setSound).toHaveBeenCalledWith('trinity', true);
    });

    it('clicking the SECOND row’s Remove removes that keyword', async () => {
      const { fixture, remove } = await build();

      removeButtons(fixture)[1].click();
      fixture.detectChanges();

      expect(remove).toHaveBeenCalledWith('trinity');
    });

    it('Enter in the field adds the word and swallows the submit', async () => {
      // Enter is the primary way anyone adds a keyword, and the e2e clicks the button —
      // so nothing exercised this path or the preventDefault its comment justifies.
      const { cmp, fixture, add } = await build({ keywords: [[]] });
      cmp.keywordForm.word().value.set('oncall');
      fixture.detectChanges();
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      });

      el(fixture)
        .querySelector('[data-testid="keyword-input"]')
        ?.dispatchEvent(event);

      expect(add).toHaveBeenCalledWith('oncall');
      expect(event.defaultPrevented).toBe(true);
    });

    it('keeps Add disabled until something is typed', async () => {
      const { cmp, fixture } = await build({ keywords: [[]] });

      expect(addButton(fixture)?.disabled).toBe(true);

      cmp.keywordForm.word().value.set('   '); // whitespace is nothing typed
      fixture.detectChanges();
      expect(addButton(fixture)?.disabled).toBe(true);

      cmp.keywordForm.word().value.set('oncall');
      fixture.detectChanges();
      expect(addButton(fixture)?.disabled).toBe(false);
    });

    it('disables Add while the write is in flight, and frees it if that fails', async () => {
      // Folding the two `adding.set(false)` calls into a `complete:` handler is a very
      // plausible tidy-up, and `complete` never fires on an errored Observable — the
      // button would sit on "Adding…" forever.
      const failing = new Subject<void>();
      const { cmp, fixture } = await build({
        keywords: [[]],
        add: vi.fn(() => failing),
      });
      cmp.keywordForm.word().value.set('oncall');
      cmp.add();
      fixture.detectChanges();
      expect(addButton(fixture)?.disabled).toBe(true);
      expect(addButton(fixture)?.textContent?.trim()).toBe('Adding…');

      failing.error(new Error('nope'));
      fixture.detectChanges();

      expect(addButton(fixture)?.disabled).toBe(false);
    });

    it('disables only the row being written to, and re-enables it after', async () => {
      const pending = new Subject<void>();
      const { cmp, fixture } = await build({ remove: vi.fn(() => pending) });

      cmp.remove(LOUD);
      fixture.detectChanges();
      expect(removeButtons(fixture)[0].disabled).toBe(true);
      expect(soundControls(fixture)[0].disabled).toBe(true);
      expect(removeButtons(fixture)[1].disabled).toBe(false); // the other row is untouched

      pending.next();
      pending.complete();
      fixture.detectChanges();

      expect(removeButtons(fixture)[0].disabled).toBe(false);
    });

    it('restores the row that failed and leaves the others alone', async () => {
      // Every other checkbox test uses row 0, where a per-row lookup and a hardcoded
      // first row agree — so the scoping itself would otherwise be unpinned.
      const pending = new Subject<void>();
      const { cmp, fixture } = await build({ setSound: vi.fn(() => pending) });
      const boxes = () => checkboxes(fixture).map((b) => b.componentInstance);
      // QUIET starts false; toggling it on is what clicking its checkbox calls.
      cmp.toggleSound(QUIET, true);
      fixture.detectChanges();
      pending.error(new Error('nope'));
      fixture.detectChanges();

      expect(boxes()[1].checked()).toBe(false); // back to the server's value
      expect(boxes()[0].checked()).toBe(true); // untouched
    });

    it('shows no Off badge on a keyword that is live', async () => {
      const { fixture } = await build();

      expect(
        el(fixture).querySelector('[data-testid="keyword-off"]'),
      ).toBeNull();
    });
  });
});
