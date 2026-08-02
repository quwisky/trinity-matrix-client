import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Dialog, DialogRef } from '@angular/cdk/dialog';
import {
  SearchService,
  type SwitcherResult,
} from '@trinity/data-access/search';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { signal } from '@angular/core';
import { QuickSwitcherComponent } from './quick-switcher.component';
import { QuickSwitcherService } from './quick-switcher.service';
import { AccountBadgesService } from '../shared/account-badges.service';

function result(over: Partial<SwitcherResult> = {}): SwitcherResult {
  return {
    kind: 'room',
    id: '!r:hs',
    title: 'room',
    avatarMxc: null,
    initial: 'R',
    score: 100,
    ...over,
  };
}

const LOCAL: SwitcherResult[] = [
  result({ kind: 'room', id: '!a:hs', title: 'alpha' }),
  result({ kind: 'space', id: '!b:hs', title: 'bravo' }),
  result({ kind: 'dm', id: '!c:hs', title: 'charlie' }),
];

describe('QuickSwitcherComponent', () => {
  let dismiss: ReturnType<typeof vi.fn>;
  let localResults: ReturnType<typeof vi.fn>;
  let searchPeople: ReturnType<typeof vi.fn>;

  function setInput(value: string, instance: QuickSwitcherComponent): void {
    instance.onInput({ target: { value } } as unknown as Event);
  }

  function keyEvent(): {
    event: Event;
    preventDefault: ReturnType<typeof vi.fn>;
  } {
    const preventDefault = vi.fn();
    return { event: { preventDefault } as unknown as Event, preventDefault };
  }

  beforeEach(() => {
    dismiss = vi.fn().mockResolvedValue(true);
    localResults = vi.fn(() => LOCAL);
    searchPeople = vi.fn(() => of<SwitcherResult[]>([]));
  });

  /** Render the switcher with the dialog ref and search service stubbed. */
  function renderSwitcher(
    opts: { inputs?: Record<string, unknown>; activeUserId?: string } = {},
  ) {
    return render(QuickSwitcherComponent, {
      ...(opts.inputs ? { inputs: opts.inputs } : {}),
      providers: [
        { provide: DialogRef, useValue: { close: dismiss } },
        MockProvider(SearchService, { localResults, searchPeople }),
        MockProvider(MatrixClientService, {
          activeUserId: signal<string | null>(
            opts.activeUserId ?? '@me:hs',
          ).asReadonly(),
        }),
        MockProvider(AccountBadgesService, {
          forAccount: (id?: string) =>
            id
              ? { id, name: id, initial: id[1].toUpperCase(), avatarMxc: null }
              : null,
        }),
      ],
    });
  }

  it('marks the search field as the dialog’s autofocus target', async () => {
    // QuickSwitcherService opens with `autoFocus: '[data-autofocus]'`; CDK focuses
    // nothing at all if that selector matches nothing, so the two must stay paired.
    const { container } = await renderSwitcher();
    const focusTarget = container.querySelector('[data-autofocus]');
    expect(focusTarget?.tagName).toBe('INPUT');
    expect(focusTarget?.getAttribute('placeholder')).toBe(
      'Search rooms, spaces, people',
    );
  });

  it('lands focus in the search field when opened through the service', async () => {
    // The full production path in one test — real QuickSwitcherService, real
    // TrnDialogService, real CDK dialog — because that is where the bug lived: the
    // component's own focus() ran first and CDK's focus pass then overrode it with the
    // header's Cancel button. Only the search backend is stubbed.
    TestBed.configureTestingModule({
      providers: [MockProvider(SearchService, { localResults, searchPeople })],
    });
    const picked = TestBed.inject(QuickSwitcherService).pick();
    const appRef = TestBed.inject(ApplicationRef);
    appRef.tick();
    await appRef.whenStable();

    const search = document.querySelector('[data-autofocus]');
    expect(search).not.toBeNull();
    expect(document.activeElement).toBe(search);

    TestBed.inject(Dialog).closeAll();
    expect(await picked).toBeNull();
  });

  it('renders the ranked local results as rows', async () => {
    const { fixture, container } = await renderSwitcher();

    expect(fixture.componentInstance.results()).toEqual(LOCAL);
    expect(container.querySelectorAll('.qs-row').length).toBe(LOCAL.length);
  });

  it('recomputes results when the query changes', async () => {
    const { fixture } = await renderSwitcher();
    const c = fixture.componentInstance;
    localResults.mockImplementation((q: string) =>
      q === 'alp' ? [LOCAL[0]] : LOCAL,
    );

    setInput('alp', c);

    // Read first so the lazy `results` computed re-evaluates against the new query.
    expect(c.results()).toEqual([LOCAL[0]]);
    expect(localResults).toHaveBeenLastCalledWith('alp', undefined, undefined);
  });

  it('moves the highlight with arrow keys, wrapping and preventing the caret move', async () => {
    const { fixture } = await renderSwitcher();
    const c = fixture.componentInstance;

    const down = keyEvent();
    c.move(1, down.event);
    expect(c.highlight()).toBe(1);
    expect(down.preventDefault).toHaveBeenCalled();

    c.move(1, keyEvent().event);
    c.move(1, keyEvent().event); // 2 -> wraps to 0
    expect(c.highlight()).toBe(0);

    c.move(-1, keyEvent().event); // 0 -> wraps to last
    expect(c.highlight()).toBe(LOCAL.length - 1);
  });

  // Focus never leaves the input while arrowing, so a screen reader learns which row is
  // active ONLY from aria-activedescendant pointing at that row's id. A purely visual
  // highlight leaves the list unusable without sight.
  it('announces the active row to assistive tech as the highlight moves', async () => {
    const { fixture, container } = await renderSwitcher();
    const c = fixture.componentInstance;
    const input = container.querySelector('input')!;

    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-controls')).toBe('qs-results');
    expect(input.getAttribute('aria-activedescendant')).toBe('qs-result-0');

    const rows = container.querySelectorAll('[role="option"]');
    expect(rows).toHaveLength(LOCAL.length);
    expect(rows[0].getAttribute('aria-selected')).toBe('true');
    expect(rows[1].getAttribute('aria-selected')).toBe('false');

    // Arrow down: the pointer must follow the highlight, or the announcement is stale.
    c.move(1, keyEvent().event);
    fixture.detectChanges();

    expect(input.getAttribute('aria-activedescendant')).toBe('qs-result-1');
    expect(
      container.querySelector('#qs-result-1')?.getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('Enter selects the highlighted row and dismisses with its {kind,id}', async () => {
    const { fixture } = await renderSwitcher();
    const c = fixture.componentInstance;
    c.highlight.set(1); // bravo (space)

    c.choose(keyEvent().event);

    expect(dismiss).toHaveBeenCalledWith({ kind: 'space', id: '!b:hs' });
  });

  it('clicking a row dismisses with its selection', async () => {
    const { fixture } = await renderSwitcher();
    const c = fixture.componentInstance;

    c.select(LOCAL[2]);

    expect(dismiss).toHaveBeenCalledWith({ kind: 'dm', id: '!c:hs' });
  });

  it('Escape / Cancel dismisses with null', async () => {
    const { fixture } = await renderSwitcher();
    const c = fixture.componentInstance;

    c.dismiss(null);

    expect(dismiss).toHaveBeenCalledWith(null);
  });

  it('appends debounced directory people after the local results', async () => {
    const people: SwitcherResult[] = [
      result({
        kind: 'user',
        id: '@bob:hs',
        title: 'Bob',
        subtitle: '@bob:hs',
        score: 0,
      }),
    ];
    searchPeople.mockReturnValue(of(people));
    const { fixture } = await renderSwitcher();
    const c = fixture.componentInstance;

    setInput('bob', c);
    fixture.detectChanges(); // flush the toObservable effect
    await new Promise((resolve) => setTimeout(resolve, 320)); // debounce window
    fixture.detectChanges();

    expect(searchPeople).toHaveBeenCalledWith('bob');
    expect(c.results()).toEqual([...LOCAL, ...people]);
  });

  it('does not query the directory for a term shorter than two characters', async () => {
    const { fixture } = await renderSwitcher();

    setInput('b', fixture.componentInstance);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 320));

    expect(searchPeople).not.toHaveBeenCalled();
  });

  // The mixed corpus is only useful if each row says which account it belongs to — the
  // same name can exist on two accounts, and picking one silently changes who you act as.
  it('badges a result that belongs to another account', async () => {
    localResults = vi.fn(() => [
      result({ id: '!mine:hs', title: 'alpha', accountId: '@me:hs' }),
      result({ id: '!theirs:hs', title: 'alpha team', accountId: '@alt:hs' }),
    ]);
    const { container } = await renderSwitcher();

    expect(
      container.querySelectorAll('[data-testid="account-badge"]').length,
    ).toBe(2);
  });

  it('renders no badges when the rows carry no account', async () => {
    const { container } = await renderSwitcher();
    expect(container.querySelector('[data-testid="account-badge"]')).toBeNull();
  });

  // Forwarding sends through the active client without switching, so its picker must hide
  // rooms the active account isn't in. The scope goes INTO the query rather than filtering
  // the answer: post-filtering would let a busier account fill the result cap and starve
  // the active account's rooms out entirely.
  it('asks the search service to scope the corpus to the active account', async () => {
    await renderSwitcher({
      inputs: { activeAccountOnly: true },
      activeUserId: '@me:hs',
    });

    expect(localResults).toHaveBeenLastCalledWith('', undefined, '@me:hs');
  });

  it('leaves the corpus unscoped for an ordinary jump', async () => {
    await renderSwitcher({ activeUserId: '@me:hs' });

    expect(localResults).toHaveBeenLastCalledWith('', undefined, undefined);
  });
});
