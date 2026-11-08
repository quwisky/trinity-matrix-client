import { inject, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { lastInputTarget } from '@trinity/components/overlay';
import { fireEvent, render } from '@trinity/testing';
import {
  type LoadedMessageSearch,
  type MessageHit,
  type ServerMessageSearch,
  ConversationRuntime,
} from '@trinity/data-access/timeline';
import { AvatarComponent } from '@trinity/components/generic-content';
import { RoomMembersService } from '@trinity/data-access/room-administration';
import { MockComponent, MockProvider } from 'ng-mocks';
import { of, Subject, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { MessageSearchComponent } from './message-search.component';
import { ConversationTimelineStub } from '../testing/conversation-timeline.stub';

function hit(over: Partial<MessageHit> = {}): MessageHit {
  return {
    eventId: '$e:hs',
    roomId: '!r:hs',
    roomName: 'General',
    sender: '@alice:hs',
    senderName: 'Alice',
    senderAvatarMxc: null,
    body: 'hello world',
    ts: 1000,
    snippet: 'hello world',
    shield: null,
    ...over,
  };
}

function loaded(over: Partial<LoadedMessageSearch> = {}): LoadedMessageSearch {
  return {
    hits: [],
    scanned: 0,
    encrypted: false,
    serverAvailable: true,
    ...over,
  };
}

describe('MessageSearchComponent', () => {
  /** What the panel announced: it is presentational, so these ARE its contract. */
  let selected: string[];
  let elsewhere: { roomId: string; eventId: string }[];
  let dismissals: number;
  let searchLoadedMessages: Mock;
  let searchServerMessages: Mock;
  let loadMoreHistory: Mock;

  async function build(
    state: LoadedMessageSearch,
    extraInputs: { query?: string } = {},
  ): Promise<{
    fixture: ComponentFixture<MessageSearchComponent>;
    container: HTMLElement;
    c: MessageSearchComponent;
  }> {
    searchLoadedMessages.mockReturnValue(state);
    const { fixture, container } = await render(MessageSearchComponent, {
      inputs: { roomId: '!r:hs', ...extraInputs },
      on: {
        selected: (eventId: string) => selected.push(eventId),
        selectedElsewhere: (hit: { roomId: string; eventId: string }) =>
          elsewhere.push(hit),
        dismissed: () => {
          dismissals += 1;
        },
      },
      imports: [MockComponent(AvatarComponent)],
      providers: [
        MockProvider(ConversationTimelineStub, { messages: signal([]) }),
        MockProvider(RoomMembersService, {
          membersFor: () =>
            signal([
              {
                userId: '@bo:hs',
                roomDisplayName: 'Bo',
              } as never,
            ]),
        }),
        {
          provide: ConversationRuntime,
          useFactory: () => ({
            timeline: inject(ConversationTimelineStub),
            search: {
              searchLoaded: searchLoadedMessages,
              searchServer: searchServerMessages,
              loadOlder: loadMoreHistory,
            },
          }),
        },
      ],
    });
    return { fixture, container, c: fixture.componentInstance };
  }

  function setQuery(value: string, c: MessageSearchComponent): void {
    c.onInput({ target: { value } } as unknown as Event);
  }

  beforeEach(() => {
    selected = [];
    elsewhere = [];
    dismissals = 0;
    searchLoadedMessages = vi.fn(() => loaded());
    searchServerMessages = vi.fn(() =>
      of<ServerMessageSearch>({ hits: [], count: 0, nextBatch: null }),
    );
    loadMoreHistory = vi.fn(() => of(0));
  });

  // Closing the panel or replacing it with another destroys it; the CDK's input-modality
  // detector kept the pressed field, and through it the whole detached panel (#1361).
  it('lets go of the last pressed element inside it when it goes', async () => {
    const { fixture, container } = await build(loaded());
    const field = container.querySelector('[data-autofocus]') as HTMLElement;
    const last = () => TestBed.runInInjectionContext(lastInputTarget);
    field.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, buttons: 1, detail: 1 }),
    );
    expect(last()).toBe(field);

    fixture.destroy();

    expect(last()).toBeNull();
  });

  it('lands focus in the query field as soon as the panel renders', async () => {
    // The panel is rendered inline in the shell's slot now, so nothing else focuses it.
    // As a dialog this was CDK's job (`autoFocus: '[data-autofocus]'`); the conversion
    // would silently have left a keyboard user tabbing into the field they just asked for.
    const { container } = await build(loaded());

    const query = container.querySelector('[data-autofocus]');
    expect(query?.tagName).toBe('INPUT');
    expect(query?.getAttribute('placeholder')).toBe('Search this conversation');
    expect(document.activeElement).toBe(query);
  });

  it('does not grab focus while the header search field is being typed in', async () => {
    const header = document.createElement('input');
    header.type = 'search';
    document.body.append(header);
    header.focus();
    try {
      const { container } = await build(loaded(), { query: 'abc' });

      const field =
        container.querySelector<HTMLInputElement>('[data-autofocus]');
      expect(field?.value).toBe('abc');
      expect(document.activeElement).toBe(header);
    } finally {
      header.remove();
    }
  });

  it('focuses its own field when reopened with a query from elsewhere', async () => {
    const { container } = await build(loaded(), { query: 'abc' });

    const field = container.querySelector<HTMLInputElement>('[data-autofocus]');
    expect(field?.value).toBe('abc');
    expect(document.activeElement).toBe(field);
  });

  it('drops server results when the bound query changes from outside', async () => {
    const { fixture, c } = await build(loaded());
    fixture.componentRef.setInput('query', 'hello');
    fixture.detectChanges();
    c.searchServer();
    expect(c.serverMode()).toBe(true);

    fixture.componentRef.setInput('query', 'hello w');
    fixture.detectChanges();
    expect(c.serverMode()).toBe(false);
  });

  it('shows a bound query in its field', async () => {
    const { fixture, container } = await build(loaded());
    fixture.componentRef.setInput('query', 'abc');
    fixture.detectChanges();

    const field = container.querySelector<HTMLInputElement>('[data-autofocus]');
    expect(field?.value).toBe('abc');
  });

  it('writes typing back to the bound query model', async () => {
    const { fixture, c } = await build(loaded());
    const changes: string[] = [];
    c.query.subscribe((value) => changes.push(value));
    setQuery('typed', c);
    fixture.detectChanges();

    expect(c.query()).toBe('typed');
    expect(changes).toEqual(['typed']);
  });

  it('renders the loaded-timeline matches as result rows', async () => {
    const { container } = await build(
      loaded({ hits: [hit({ eventId: '$1' }), hit({ eventId: '$2' })] }),
    );

    expect(container.querySelectorAll('[data-testid="result"]').length).toBe(2);
  });

  it('marks a result that arrived unencrypted', async () => {
    const { container } = await build(
      loaded({
        hits: [
          hit({
            shield: {
              level: 'unencrypted' as const,
              reason: 'Not encrypted',
              explanation:
                'This message was sent without end-to-end encryption.',
            },
          }),
          hit({ eventId: '$2' }),
        ],
      }),
    );

    expect(
      container.querySelectorAll(
        '[data-testid="unencrypted-mark-unencrypted"]',
      ),
    ).toHaveLength(1);
  });

  it('shows the E2EE note (with the scanned count) and no server toggle for an encrypted room', async () => {
    const { fixture, container, c } = await build(
      loaded({ encrypted: true, serverAvailable: false, scanned: 7 }),
    );
    setQuery('hi', c);
    fixture.detectChanges();

    const note = container.querySelector('[data-testid="e2ee-note"]');
    expect(note).toBeTruthy();
    expect(note?.textContent).toContain('7');
    expect(note?.textContent?.toLowerCase()).toContain('loaded');
    // The full-history server search is never offered for an encrypted room.
    expect(container.querySelector('[data-testid="search-server"]')).toBeNull();
    expect(container.querySelector('[data-testid="load-older"]')).toBeTruthy();
  });

  it('offers the server search for an unencrypted room with a query', async () => {
    const { fixture, container, c } = await build(loaded({ encrypted: false }));
    setQuery('hello', c);
    fixture.detectChanges();

    // The button belongs in the banner's action slot, not its text.
    expect(
      container
        .querySelector('[data-testid="search-server"]')
        ?.closest('.banner__actions'),
    ).toBeTruthy();
    expect(container.querySelector('[data-testid="e2ee-note"]')).toBeNull();
  });

  it('emits the chosen event id when a result row is clicked', async () => {
    const { container } = await build(
      loaded({ hits: [hit({ eventId: '$jump' })] }),
    );

    fireEvent.click(
      container.querySelector<HTMLButtonElement>('[data-testid="result"]')!,
    );

    // The id — not just "something happened" — is the whole contract with the host.
    expect(selected).toEqual(['$jump']);
    // A pick is a pick, not a bare close: the host distinguishes the two.
    expect(dismissals).toBe(0);
  });

  it('cancel emits dismissed, with nothing selected', async () => {
    const { container } = await build(loaded());

    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Close search"]',
      )!,
    );

    expect(dismissals).toBe(1);
    expect(selected).toEqual([]);
  });

  it('Escape in the query field emits dismissed', async () => {
    const { container } = await build(loaded());

    fireEvent.keyDown(container.querySelector('[data-autofocus]')!, {
      key: 'Escape',
    });

    expect(dismissals).toBe(1);
    expect(selected).toEqual([]);
  });

  it('"load older messages" pages in history via the service', async () => {
    loadMoreHistory.mockReturnValue(of(40));
    const { c } = await build(
      loaded({ encrypted: true, serverAvailable: false }),
    );

    c.loadOlderHistory();

    expect(loadMoreHistory).toHaveBeenCalledWith();
  });

  it('runs the server search and shows its paged results', async () => {
    searchServerMessages.mockReturnValue(
      of<ServerMessageSearch>({
        hits: [hit({ eventId: '$s1', senderName: 'Bob' })],
        count: 3,
        nextBatch: 'b2',
      }),
    );
    const { fixture, container, c } = await build(loaded({ encrypted: false }));
    setQuery('hello', c);
    fixture.detectChanges(); // the query's own reset runs before the search is requested

    c.searchServer();
    fixture.detectChanges();

    expect(searchServerMessages).toHaveBeenCalledWith('hello', undefined, {
      scope: 'room',
      sender: null,
    });
    expect(c.serverMode()).toBe(true);
    expect(c.results().map((h) => h.eventId)).toEqual(['$s1']);
    expect(c.serverCount()).toBe(3);
    expect(c.serverNextBatch()).toBe('b2');
    expect(
      container.querySelector('[data-testid="load-more-server"]'),
    ).toBeTruthy();
  });

  it('shows the encrypted-room note, not an empty result, when the server search is refused for encryption', async () => {
    searchServerMessages.mockReturnValue(
      of<ServerMessageSearch>({
        hits: [],
        count: 0,
        nextBatch: null,
        encrypted: true,
      }),
    );
    const { fixture, container, c } = await build(loaded({ encrypted: false }));
    setQuery('hello', c);
    fixture.detectChanges();

    c.searchServer();
    fixture.detectChanges();

    expect(c.serverMode()).toBe(false);
    expect(container.querySelector('[data-testid="e2ee-note"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="search-server"]')).toBeNull();
  });

  it('appends the next page of server results on load-more', async () => {
    const { c } = await build(loaded({ encrypted: false }));
    setQuery('hello', c);
    searchServerMessages.mockReturnValueOnce(
      of<ServerMessageSearch>({
        hits: [hit({ eventId: '$s1' })],
        count: 3,
        nextBatch: 'b2',
      }),
    );
    c.searchServer();

    searchServerMessages.mockReturnValueOnce(
      of<ServerMessageSearch>({
        hits: [hit({ eventId: '$s2' })],
        count: 3,
        nextBatch: null,
      }),
    );
    c.loadMoreServer();

    expect(searchServerMessages).toHaveBeenLastCalledWith('hello', 'b2', {
      scope: 'room',
      sender: null,
    });
    expect(c.results().map((h) => h.eventId)).toEqual(['$s1', '$s2']);
    expect(c.serverNextBatch()).toBeNull();
  });

  it('a changed query reverts from server mode to instant loaded results', async () => {
    searchServerMessages.mockReturnValue(
      of<ServerMessageSearch>({
        hits: [hit({ eventId: '$s1' })],
        count: 1,
        nextBatch: null,
      }),
    );
    const { fixture, c } = await build(
      loaded({ hits: [hit({ eventId: '$loaded' })] }),
    );
    setQuery('hello', c);
    fixture.detectChanges();
    c.searchServer();
    expect(c.serverMode()).toBe(true);

    setQuery('hell', c);
    fixture.detectChanges();

    expect(c.serverMode()).toBe(false);
    expect(c.results().map((h) => h.eventId)).toEqual(['$loaded']);
  });

  describe('in-flight server searches', () => {
    const page = (id: string, nextBatch: string | null = null) =>
      ({
        hits: [hit({ eventId: id })],
        count: 1,
        nextBatch,
      }) as ServerMessageSearch;

    it('never renders an older term that resolves after a newer search', async () => {
      const foo = new Subject<ServerMessageSearch>();
      const foob = new Subject<ServerMessageSearch>();
      searchServerMessages.mockReturnValueOnce(foo).mockReturnValueOnce(foob);
      const { fixture, c } = await build(loaded({ encrypted: false }));
      setQuery('foo', c);
      fixture.detectChanges();
      c.searchServer();
      setQuery('foob', c);
      fixture.detectChanges();
      c.searchServer();

      foob.next(page('$foob'));
      foo.next(page('$foo'));

      expect(c.results().map((h) => h.eventId)).toEqual(['$foob']);
    });

    it('drops a result that lands after the query reset', async () => {
      const foo = new Subject<ServerMessageSearch>();
      searchServerMessages.mockReturnValueOnce(foo);
      const { fixture, c } = await build(loaded({ encrypted: false }));
      setQuery('foo', c);
      fixture.detectChanges();
      c.searchServer();
      setQuery('fo', c);
      fixture.detectChanges();

      foo.next(page('$foo', 'b2'));

      expect(c.serverMode()).toBe(false);
      expect(c.serverNextBatch()).toBeNull();
      expect(c.searching()).toBe(false);
    });

    it('drops a load-more page for a term that has since changed', async () => {
      searchServerMessages.mockReturnValueOnce(of(page('$s1', 'b2')));
      const more = new Subject<ServerMessageSearch>();
      searchServerMessages.mockReturnValueOnce(more);
      const { fixture, c } = await build(loaded({ encrypted: false }));
      setQuery('foo', c);
      fixture.detectChanges();
      c.searchServer();
      c.loadMoreServer();
      setQuery('foob', c);
      fixture.detectChanges();
      searchServerMessages.mockReturnValueOnce(of(page('$new', null)));
      c.searchServer();

      more.next(page('$old-more', 'b9'));

      expect(c.results().map((h) => h.eventId)).toEqual(['$new']);
      expect(c.serverNextBatch()).toBeNull();
    });
  });

  describe('filters, day groups and the count', () => {
    it('counts the results in the header once there is a query', async () => {
      const { fixture, container, c } = await build(
        loaded({ hits: [hit({ eventId: '$1' }), hit({ eventId: '$2' })] }),
      );
      setQuery('hello', c);
      fixture.detectChanges();

      expect(
        container.querySelector('.side-panel-header__subtitle')?.textContent,
      ).toBe('2 results');
    });

    it('groups results by day, newest first', async () => {
      const now = Date.now();
      const { fixture, container, c } = await build(
        loaded({
          hits: [
            hit({ eventId: '$today', ts: now }),
            hit({ eventId: '$week', ts: now - 3 * 86_400_000 }),
          ],
        }),
      );
      setQuery('hello', c);
      fixture.detectChanges();

      const groups = [...container.querySelectorAll('.ms-group')].map((g) =>
        g.textContent?.trim(),
      );
      expect(groups).toEqual(['Today', 'Last week']);
    });

    it('narrows the loaded search to one author', async () => {
      const { fixture, c } = await build(loaded());
      setQuery('hello', c);
      c.setSender({ id: '@bo:hs', name: 'Bo' });
      fixture.detectChanges();

      expect(searchLoadedMessages).toHaveBeenLastCalledWith('hello', '@bo:hs');
    });

    it('asks the homeserver across every room once typing pauses', async () => {
      vi.useFakeTimers();
      try {
        const { fixture, c } = await build(loaded());
        c.setScope('all-rooms');
        setQuery('hello', c);
        fixture.detectChanges();
        expect(searchServerMessages).not.toHaveBeenCalled();

        vi.advanceTimersByTime(400);

        expect(searchServerMessages).toHaveBeenCalledWith('hello', undefined, {
          scope: 'all-rooms',
          sender: null,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('opens a result from another room through the host', async () => {
      const { fixture, container, c } = await build(loaded());
      searchServerMessages.mockReturnValue(
        of<ServerMessageSearch>({
          hits: [
            hit({ eventId: '$far', roomId: '!other:hs', roomName: 'Far' }),
          ],
          count: 1,
          nextBatch: null,
        }),
      );
      setQuery('hello', c);
      c.setScope('all-rooms');
      fixture.detectChanges();
      c.searchServer();
      fixture.detectChanges();

      expect(
        container.querySelector('[data-testid="result-room"]')?.textContent,
      ).toBe('Far');
      fireEvent.click(container.querySelector('[data-testid="result"]')!);
      expect(elsewhere).toEqual([{ roomId: '!other:hs', eventId: '$far' }]);
      expect(selected).toEqual([]);
    });

    it('marks the last opened result as current', async () => {
      const { fixture, container, c } = await build(
        loaded({ hits: [hit({ eventId: '$1' })] }),
      );
      setQuery('hello', c);
      fixture.detectChanges();
      fireEvent.click(container.querySelector('[data-testid="result"]')!);
      fixture.detectChanges();

      expect(
        container
          .querySelector('[data-testid="result"]')
          ?.getAttribute('aria-current'),
      ).toBe('true');
    });
  });

  describe('review fixes', () => {
    it('says a failed server search failed, and retries it', async () => {
      searchServerMessages.mockReturnValueOnce(
        throwError(() => new Error('M_UNKNOWN: boom')),
      );
      const { fixture, container, c } = await build(loaded());
      setQuery('hello', c);
      fixture.detectChanges();
      c.searchServer();
      fixture.detectChanges();

      const alert = container.querySelector('[data-testid="search-error"]');
      expect(alert?.textContent).toContain('Try again');
      expect(alert?.textContent).not.toContain('M_UNKNOWN');
      expect(container.textContent).not.toContain('No results');

      searchServerMessages.mockReturnValueOnce(
        of<ServerMessageSearch>({ hits: [hit()], count: 1, nextBatch: null }),
      );
      fireEvent.click(
        container.querySelector<HTMLButtonElement>(
          '[data-testid="search-retry"]',
        )!,
      );
      fixture.detectChanges();
      expect(searchServerMessages).toHaveBeenCalledTimes(2);
      expect(
        container.querySelector('[data-testid="search-error"]'),
      ).toBeNull();
      expect(container.querySelectorAll('[data-testid="result"]')).toHaveLength(
        1,
      );
    });

    it('counts loaded hits with a "+" while a sender filter has more pages', async () => {
      searchServerMessages.mockReturnValue(
        of<ServerMessageSearch>({
          hits: [hit({ eventId: '$1' }), hit({ eventId: '$2' })],
          // Synapse counts before it filters senders.
          count: 40,
          nextBatch: 'b2',
        }),
      );
      const { fixture, container, c } = await build(loaded());
      setQuery('hello', c);
      c.setSender({ id: '@alice:hs', name: 'Alice' });
      fixture.detectChanges();
      c.searchServer();
      fixture.detectChanges();

      expect(
        container.querySelector('.side-panel-header__subtitle')?.textContent,
      ).toBe('2+ results');
    });

    it('notes that encrypted rooms are left out of an all-rooms search with results', async () => {
      searchServerMessages.mockReturnValue(
        of<ServerMessageSearch>({ hits: [hit()], count: 1, nextBatch: null }),
      );
      const { fixture, container, c } = await build(loaded());
      setQuery('hello', c);
      c.setScope('all-rooms');
      fixture.detectChanges();
      c.searchServer();
      fixture.detectChanges();

      expect(
        container.querySelector('[data-testid="all-rooms-note"]')?.textContent,
      ).toContain('Encrypted rooms aren’t included');
    });

    it('announces the result count politely, once typing settles', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const { fixture, container, c } = await build(
          loaded({ hits: [hit({ eventId: '$1' })] }),
        );
        const live = () =>
          container.querySelector('[data-testid="search-count-status"]');
        setQuery('h', c);
        fixture.detectChanges();
        vi.advanceTimersByTime(500);
        setQuery('hello', c);
        fixture.detectChanges();
        expect(live()?.textContent?.trim()).toBe('');

        vi.advanceTimersByTime(1_000);
        fixture.detectChanges();
        expect(live()?.getAttribute('role')).toBe('status');
        expect(live()?.textContent?.trim()).toBe('1 result');
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears the count announcement when the query is cleared', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const { fixture, container, c } = await build(
          loaded({ hits: [hit({ eventId: '$1' })] }),
        );
        const live = () =>
          container.querySelector('[data-testid="search-count-status"]');
        setQuery('hello', c);
        fixture.detectChanges();
        vi.advanceTimersByTime(1_000);
        fixture.detectChanges();
        expect(live()?.textContent?.trim()).toBe('1 result');

        setQuery('', c);
        fixture.detectChanges();
        expect(live()?.textContent?.trim()).toBe('');
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the count announcement outside the body the skeleton replaces', async () => {
      const { container } = await build(loaded());
      const live = container.querySelector(
        '[data-testid="search-count-status"]',
      );
      expect(live).not.toBeNull();
      expect(live?.closest('.side-panel__body')).toBeNull();
    });

    it('keeps the instant results until the homeserver answers', async () => {
      const reply = new Subject<ServerMessageSearch>();
      searchServerMessages.mockReturnValue(reply);
      const { fixture, container, c } = await build(
        loaded({ hits: [hit({ eventId: '$loaded' })] }),
      );
      setQuery('hello', c);
      fixture.detectChanges();
      c.searchServer();
      fixture.detectChanges();
      expect(c.results().map((h) => h.eventId)).toEqual(['$loaded']);
      expect(container.querySelectorAll('[data-testid="result"]')).toHaveLength(
        1,
      );

      reply.next({
        hits: [hit({ eventId: '$s1' })],
        count: 1,
        nextBatch: null,
      });
      fixture.detectChanges();
      expect(c.results().map((h) => h.eventId)).toEqual(['$s1']);
    });

    it('drops the server summary while its search has failed', async () => {
      searchServerMessages.mockReturnValueOnce(
        of<ServerMessageSearch>({ hits: [hit()], count: 3, nextBatch: 'b2' }),
      );
      const { fixture, container, c } = await build(loaded());
      setQuery('hello', c);
      fixture.detectChanges();
      c.searchServer();
      searchServerMessages.mockReturnValueOnce(
        throwError(() => new Error('boom')),
      );
      c.loadMoreServer();
      fixture.detectChanges();

      expect(
        container.querySelector('[data-testid="search-error"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="server-summary"]'),
      ).toBeNull();
    });

    it('quotes what the sender filter kept, not the homeserver count, in the summary', async () => {
      searchServerMessages.mockReturnValue(
        of<ServerMessageSearch>({
          hits: [hit({ eventId: '$1' }), hit({ eventId: '$2' })],
          count: 40,
          nextBatch: 'b2',
        }),
      );
      const { fixture, container, c } = await build(loaded());
      setQuery('hello', c);
      c.setSender({ id: '@alice:hs', name: 'Alice' });
      fixture.detectChanges();
      c.searchServer();
      fixture.detectChanges();

      const summary = container.querySelector(
        '[data-testid="server-summary"]',
      )?.textContent;
      expect(summary).toContain('2+');
      expect(summary).not.toContain('40');
    });

    it('says "No matches yet" and offers more when a filtered page kept nothing', async () => {
      searchServerMessages.mockReturnValue(
        of<ServerMessageSearch>({ hits: [], count: 40, nextBatch: 'b2' }),
      );
      const { fixture, container, c } = await build(loaded());
      setQuery('hello', c);
      c.setSender({ id: '@alice:hs', name: 'Alice' });
      fixture.detectChanges();
      c.searchServer();
      fixture.detectChanges();

      expect(
        container.querySelector('.side-panel-header__subtitle')?.textContent ??
          '',
      ).not.toContain('0+');
      expect(container.textContent).toContain('No matches yet');
      expect(container.textContent).not.toContain('No results');
      expect(
        container.querySelector('[data-testid="load-more-server"]'),
      ).not.toBeNull();
    });

    it('returns focus to the From chip when the picker closes', async () => {
      const { fixture, container, c } = await build(loaded());
      const chip = container.querySelector<HTMLButtonElement>(
        '[data-testid="search-sender"]',
      )!;
      fireEvent.click(chip);
      fixture.detectChanges();
      c.setSender({ id: '@bo:hs', name: 'Bo' });
      fixture.detectChanges();
      expect(document.activeElement).toBe(chip);

      fireEvent.click(chip);
      fixture.detectChanges();
      const field = container.querySelector<HTMLInputElement>(
        'trn-search-sender-picker input',
      )!;
      fireEvent.keyDown(field, { key: 'Escape' });
      fixture.detectChanges();
      expect(container.querySelector('trn-search-sender-picker')).toBeNull();
      expect(document.activeElement).toBe(chip);
    });

    it('opens a person picker from the From chip instead of a menu of everyone', async () => {
      const { fixture, container } = await build(loaded());
      const chip = container.querySelector<HTMLButtonElement>(
        '[data-testid="search-sender"]',
      )!;
      expect(chip.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(chip);
      fixture.detectChanges();
      expect(chip.getAttribute('aria-expanded')).toBe('true');
      expect(
        container.querySelector('trn-search-sender-picker'),
      ).not.toBeNull();
    });

    it('moves "Today" to "Yesterday" at local midnight while the panel is open', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      try {
        vi.setSystemTime(new Date(2026, 10, 8, 23, 50));
        const { fixture, container, c } = await build(
          loaded({
            hits: [hit({ ts: new Date(2026, 10, 8, 23, 0).getTime() })],
          }),
        );
        setQuery('hello', c);
        fixture.detectChanges();
        const groups = () =>
          [...container.querySelectorAll('.ms-group')].map((g) =>
            g.textContent?.trim(),
          );
        expect(groups()).toEqual(['Today']);

        vi.advanceTimersByTime(15 * 60_000);
        fixture.detectChanges();
        expect(groups()).toEqual(['Yesterday']);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
