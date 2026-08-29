import { inject, signal } from '@angular/core';
import { type ComponentFixture } from '@angular/core/testing';
import { fireEvent, render } from '@trinity/testing';
import {
  SearchService,
  type LoadedMessageSearch,
  type MessageHit,
  type ServerMessageSearch,
} from '@trinity/data-access/search';
import {
  ConversationRuntime,
  TimelineService,
} from '@trinity/data-access/timeline';
import { AvatarComponent } from '@trinity/components/avatar';
import { MockComponent, MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { MessageSearchComponent } from './message-search.component';

function hit(over: Partial<MessageHit> = {}): MessageHit {
  return {
    eventId: '$e:hs',
    roomId: '!r:hs',
    sender: '@alice:hs',
    senderName: 'Alice',
    senderAvatarMxc: null,
    body: 'hello world',
    ts: 1000,
    snippet: 'hello world',
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
  let dismissals: number;
  let searchLoadedMessages: Mock;
  let searchServerMessages: Mock;
  let loadMoreHistory: Mock;

  async function build(state: LoadedMessageSearch): Promise<{
    fixture: ComponentFixture<MessageSearchComponent>;
    container: HTMLElement;
    c: MessageSearchComponent;
  }> {
    searchLoadedMessages.mockReturnValue(state);
    const { fixture, container } = await render(MessageSearchComponent, {
      inputs: { roomId: '!r:hs' },
      on: {
        selected: (eventId: string) => selected.push(eventId),
        dismissed: () => {
          dismissals += 1;
        },
      },
      imports: [MockComponent(AvatarComponent)],
      providers: [
        MockProvider(SearchService, {
          searchLoadedMessages,
          searchServerMessages,
          loadMoreHistory,
        }),
        MockProvider(TimelineService, { messages: signal([]) }),
        {
          provide: ConversationRuntime,
          useFactory: () => ({ timeline: inject(TimelineService) }),
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
    dismissals = 0;
    searchLoadedMessages = vi.fn(() => loaded());
    searchServerMessages = vi.fn(() =>
      of<ServerMessageSearch>({ hits: [], count: 0, nextBatch: null }),
    );
    loadMoreHistory = vi.fn(() => of(0));
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

  it('renders the loaded-timeline matches as result rows', async () => {
    const { container } = await build(
      loaded({ hits: [hit({ eventId: '$1' }), hit({ eventId: '$2' })] }),
    );

    expect(container.querySelectorAll('[data-testid="result"]').length).toBe(2);
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

    expect(
      container.querySelector('[data-testid="search-server"]'),
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

    expect(loadMoreHistory).toHaveBeenCalledWith('!r:hs');
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

    c.searchServer();
    fixture.detectChanges();

    expect(searchServerMessages).toHaveBeenCalledWith('!r:hs', 'hello');
    expect(c.serverMode()).toBe(true);
    expect(c.results().map((h) => h.eventId)).toEqual(['$s1']);
    expect(c.serverCount()).toBe(3);
    expect(c.serverNextBatch()).toBe('b2');
    expect(
      container.querySelector('[data-testid="load-more-server"]'),
    ).toBeTruthy();
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

    expect(searchServerMessages).toHaveBeenLastCalledWith(
      '!r:hs',
      'hello',
      'b2',
    );
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
    const { c } = await build(loaded({ hits: [hit({ eventId: '$loaded' })] }));
    setQuery('hello', c);
    c.searchServer();
    expect(c.serverMode()).toBe(true);

    setQuery('hell', c);

    expect(c.serverMode()).toBe(false);
    expect(c.results().map((h) => h.eventId)).toEqual(['$loaded']);
  });
});
