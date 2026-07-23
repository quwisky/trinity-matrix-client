import { signal } from '@angular/core';
import { ComponentFixture } from '@angular/core/testing';
import { DialogRef } from '@angular/cdk/dialog';
import { render } from '@trinity/testing';
import {
  SearchService,
  type LoadedMessageSearch,
  type MessageHit,
  type ServerMessageSearch,
} from '@trinity/data-access-search';
import { TimelineService } from '@trinity/data-access-timeline';
import { AvatarComponent } from '@trinity/ui';
import { MockComponent, MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  let dismiss: ReturnType<typeof vi.fn>;
  let searchLoadedMessages: ReturnType<typeof vi.fn>;
  let searchServerMessages: ReturnType<typeof vi.fn>;
  let loadMoreHistory: ReturnType<typeof vi.fn>;

  async function build(state: LoadedMessageSearch): Promise<{
    fixture: ComponentFixture<MessageSearchComponent>;
    container: HTMLElement;
    c: MessageSearchComponent;
  }> {
    searchLoadedMessages.mockReturnValue(state);
    const { fixture, container } = await render(MessageSearchComponent, {
      inputs: { roomId: '!r:hs' },
      imports: [MockComponent(AvatarComponent)],
      providers: [
        MockProvider(DialogRef, { close: dismiss }),
        MockProvider(SearchService, {
          searchLoadedMessages,
          searchServerMessages,
          loadMoreHistory,
        }),
        MockProvider(TimelineService, { messages: signal([]) }),
      ],
    });
    return { fixture, container, c: fixture.componentInstance };
  }

  function setQuery(value: string, c: MessageSearchComponent): void {
    c.onInput({ target: { value } } as unknown as Event);
  }

  beforeEach(() => {
    dismiss = vi.fn().mockResolvedValue(true);
    searchLoadedMessages = vi.fn(() => loaded());
    searchServerMessages = vi.fn(() =>
      of<ServerMessageSearch>({ hits: [], count: 0, nextBatch: null }),
    );
    loadMoreHistory = vi.fn(() => of(0));
  });

  it('marks the query field as the dialog’s autofocus target', async () => {
    // MessageSearchService opens with `autoFocus: '[data-autofocus]'`; CDK focuses
    // nothing at all if that selector matches nothing, so the two must stay paired.
    const { container } = await build(loaded());
    const focusTarget = container.querySelector('[data-autofocus]');
    expect(focusTarget?.tagName).toBe('INPUT');
    expect(focusTarget?.getAttribute('placeholder')).toBe(
      'Search this conversation',
    );
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

  it('dismisses with the chosen event id when a result is selected', async () => {
    const { c } = await build(loaded({ hits: [hit({ eventId: '$jump' })] }));

    c.select(hit({ eventId: '$jump' }));

    expect(dismiss).toHaveBeenCalledWith('$jump');
  });

  it('cancel dismisses with null', async () => {
    const { c } = await build(loaded());

    c.dismiss();

    expect(dismiss).toHaveBeenCalledWith(null);
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
