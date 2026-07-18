import { DialogRef } from '@angular/cdk/dialog';
import {
  SearchService,
  type SwitcherResult,
} from '@trinity/data-access-search';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickSwitcherComponent } from './quick-switcher.component';

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
  function renderSwitcher() {
    return render(QuickSwitcherComponent, {
      providers: [
        { provide: DialogRef, useValue: { close: dismiss } },
        MockProvider(SearchService, { localResults, searchPeople }),
      ],
    });
  }

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
    expect(localResults).toHaveBeenLastCalledWith('alp');
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
});
