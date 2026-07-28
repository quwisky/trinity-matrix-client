import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  KeywordRulesService,
  type KeywordRule,
} from '@trinity/data-access-notifications';
import { TrnToastService } from '@trinity/helm/overlay';
import { KeywordRulesBlockComponent } from './keyword-rules-block.component';

const LOUD: KeywordRule = { pattern: 'oncall', enabled: true, sound: true };
const QUIET: KeywordRule = { pattern: 'trinity', enabled: true, sound: false };

async function build(
  over: {
    keywords?: KeywordRule[][];
    add?: ReturnType<typeof vi.fn>;
    remove?: ReturnType<typeof vi.fn>;
    setSound?: ReturnType<typeof vi.fn>;
    has?: ReturnType<typeof vi.fn>;
  } = {},
) {
  // `keywords` is a queue of successive reads, so a test can model the list changing
  // after a write — which is how the real service behaves once it refreshes the cache.
  const reads = over.keywords ?? [[LOUD, QUIET]];
  let read = 0;
  const keywords = vi.fn(() => reads[Math.min(read++, reads.length - 1)]);
  const add = over.add ?? vi.fn(() => of(undefined));
  const remove = over.remove ?? vi.fn(() => of(undefined));
  const setSound = over.setSound ?? vi.fn(() => of(undefined));
  const has = over.has ?? vi.fn(() => false);
  const toastShow = vi.fn();
  const { fixture } = await render(KeywordRulesBlockComponent, {
    providers: [
      MockProvider(KeywordRulesService, {
        keywords,
        add,
        remove,
        setSound,
        has,
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

  it('shows an empty state rather than a bare heading', async () => {
    const { fixture } = await build({ keywords: [[]] });

    expect(text(fixture)).toContain('no keywords yet');
    expect(rows(fixture)).toHaveLength(0);
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

  it('refuses a duplicate and says so', async () => {
    const { cmp, add, toastShow } = await build({ has: vi.fn(() => true) });

    cmp.keywordForm.word().value.set('oncall');
    cmp.add();

    expect(add).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('already in your keywords'),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('keeps the typed word when the add fails, so it is not lost', async () => {
    const { cmp, toastShow } = await build({
      add: vi.fn(() => throwError(() => new Error('nope'))),
    });

    cmp.keywordForm.word().value.set('oncall');
    cmp.add();

    expect(cmp.keywordForm.word().value()).toBe('oncall');
    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('Could not add'),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('removes a keyword and re-reads the list', async () => {
    const { cmp, fixture, remove } = await build({
      keywords: [[LOUD, QUIET], [QUIET]],
    });

    cmp.remove('oncall');
    fixture.detectChanges();

    expect(remove).toHaveBeenCalledWith('oncall');
    expect(rows(fixture)).toHaveLength(1);
  });

  it('toasts and keeps the row when a remove fails', async () => {
    const { cmp, fixture, toastShow } = await build({
      remove: vi.fn(() => throwError(() => new Error('nope'))),
    });

    cmp.remove('oncall');
    fixture.detectChanges();

    expect(rows(fixture)).toHaveLength(2);
    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('Could not remove'),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('turns a keyword’s sound off without touching the keyword', async () => {
    const { cmp, setSound, remove } = await build();

    cmp.toggleSound('oncall', false);

    expect(setSound).toHaveBeenCalledWith('oncall', false);
    expect(remove).not.toHaveBeenCalled();
  });

  it('puts the checkbox back where the server has it when the write fails', async () => {
    // The checkbox is bound to the read model, so RE-READING is what un-flips it —
    // otherwise it sits showing a state the account does not actually hold. Asserting
    // the extra read is the only way to tell that apart from simply never flipping.
    const { cmp, keywords, toastShow } = await build({
      keywords: [[LOUD, QUIET]],
      setSound: vi.fn(() => throwError(() => new Error('nope'))),
    });
    expect(keywords).toHaveBeenCalledTimes(1); // the ngOnInit seed

    cmp.toggleSound('oncall', false);

    expect(keywords).toHaveBeenCalledTimes(2); // re-read on the error path
    expect(cmp.keywords()).toEqual([LOUD, QUIET]);
    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('Could not update'),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });
});
