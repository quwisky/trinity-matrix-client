import { render } from '@trinity/testing';
import {
  SpaceContentsService,
  type SpaceChildLink,
  type SpaceContentsItem,
  type SpaceContentsTarget,
  type SpaceChildWriteReceipt,
} from '@trinity/data-access/room-library';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { SpaceSettingsContentsListComponent } from './space-settings-contents-list.component';

const TARGET = { accountId: '@opening:hs', spaceId: '!space:hs' } as const;

function item(
  id: string,
  name: string,
  over: Partial<SpaceContentsItem> = {},
): SpaceContentsItem {
  return {
    id,
    name,
    initial: name[0],
    avatarMxc: null,
    kind: 'room',
    joined: true,
    via: ['hs'],
    suggested: false,
    order: '',
    ...over,
  };
}

const INITIAL = [
  item('!a:hs', 'Alpha', { order: '5' }),
  item('!b:hs', 'Bravo', { order: 'F' }),
  item('!c:hs', 'Charlie', { order: 'Z' }),
] as const;

function linksOf(...items: readonly SpaceContentsItem[]): SpaceChildLink[] {
  return items.map(({ id: childId, via, suggested, order }) => ({
    childId,
    via: [...via],
    suggested,
    order,
  }));
}

function receipt(
  ...items: readonly SpaceContentsItem[]
): SpaceChildWriteReceipt {
  return { expectedLinks: linksOf(...items) };
}

async function build(
  over: {
    setSuggested?: (
      target: SpaceContentsTarget,
      childId: string,
      suggested: boolean,
    ) => Observable<SpaceChildWriteReceipt>;
    moveChildBefore?: (
      target: SpaceContentsTarget,
      childId: string,
      beforeChildId: string | null,
    ) => Observable<SpaceChildWriteReceipt>;
    canManage?: boolean;
    items?: readonly SpaceContentsItem[];
  } = {},
) {
  const setSuggested =
    over.setSuggested ??
    vi.fn((_target, childId, suggested) => {
      const current = INITIAL.find(
        ({ id }) => id === childId,
      ) as SpaceContentsItem;
      return of(receipt({ ...current, suggested }));
    });
  const moveChildBefore =
    over.moveChildBefore ??
    vi.fn((_target, childId) => {
      const current = INITIAL.find(
        ({ id }) => id === childId,
      ) as SpaceContentsItem;
      return of(receipt({ ...current, order: 'moved' }));
    });
  const { fixture, container } = await render(
    SpaceSettingsContentsListComponent,
    {
      inputs: {
        target: TARGET,
        items: over.items ?? INITIAL,
        links: linksOf(...(over.items ?? INITIAL)),
        canManage: over.canManage ?? true,
      },
      providers: [
        MockProvider(SpaceContentsService, {
          setSuggested: (target, childId, suggested) =>
            setSuggested(target, childId, suggested),
          moveChildBefore: (target, childId, beforeChildId) =>
            moveChildBefore(target, childId, beforeChildId),
        }),
      ],
    },
  );
  return {
    cmp: fixture.componentInstance,
    fixture,
    container,
    setSuggested,
    moveChildBefore,
    async setItems(items: readonly SpaceContentsItem[]) {
      fixture.componentRef.setInput('items', items);
      fixture.componentRef.setInput('links', linksOf(...items));
      fixture.detectChanges();
      await fixture.whenStable();
    },
    async setLinks(links: readonly SpaceChildLink[]) {
      fixture.componentRef.setInput('links', links);
      fixture.detectChanges();
      await fixture.whenStable();
    },
  };
}

describe('SpaceSettingsContentsListComponent', () => {
  it('shows Suggested and explicit boundary-aware move controls on every managed row', async () => {
    const { container } = await build();

    expect(
      container.querySelector('[data-testid="space-content-suggest-!b:hs"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="space-content-move-up-!a:hs"]',
        )
        ?.hasAttribute('disabled'),
    ).toBe(true);
    expect(
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="space-content-move-down-!c:hs"]',
        )
        ?.hasAttribute('disabled'),
    ).toBe(true);
    expect(
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="space-content-move-up-!b:hs"]',
        )
        ?.getAttribute('aria-label'),
    ).toBe('Move Bravo up');
  });

  it('uses the exact target when suggesting and moving children', async () => {
    const { cmp, setSuggested, moveChildBefore, setItems } = await build();

    cmp.toggleSuggested('!b:hs', true);
    expect(setSuggested).toHaveBeenCalledWith(TARGET, '!b:hs', true);

    // A sync echo releases the first read-modify-write before the second is accepted.
    await setItems(
      INITIAL.map((entry) =>
        entry.id === '!b:hs' ? { ...entry, suggested: true } : entry,
      ),
    );
    cmp.move('!b:hs', 'up');
    expect(moveChildBefore).toHaveBeenCalledWith(TARGET, '!b:hs', '!a:hs');
  });

  it('blocks rapid repeated input through the server response and until its sync echo', async () => {
    const accepted = new Subject<SpaceChildWriteReceipt>();
    const { cmp, moveChildBefore, setItems } = await build({
      setSuggested: vi.fn(() => accepted.asObservable()),
    });

    cmp.toggleSuggested('!b:hs', true);
    cmp.move('!b:hs', 'up');
    expect(moveChildBefore).not.toHaveBeenCalled();

    accepted.next(receipt({ ...INITIAL[1], suggested: true }));
    accepted.complete();
    cmp.move('!b:hs', 'up');
    expect(moveChildBefore).not.toHaveBeenCalled();

    // A different authoritative change is not the echo for this intent.
    await setItems([...INITIAL, item('!d:hs', 'Delta')]);
    cmp.move('!b:hs', 'up');
    expect(moveChildBefore).not.toHaveBeenCalled();

    await setItems(
      INITIAL.map((entry) =>
        entry.id === '!b:hs' ? { ...entry, suggested: true } : entry,
      ),
    );
    cmp.move('!b:hs', 'up');
    expect(moveChildBefore).toHaveBeenCalledWith(TARGET, '!b:hs', '!a:hs');
  });

  it('waits for every renumbered sibling in a multi-event write receipt', async () => {
    const expected = [
      { ...INITIAL[1], order: '2' },
      { ...INITIAL[0], order: '4' },
      { ...INITIAL[2], order: '6' },
    ];
    const { cmp, setSuggested, setItems } = await build({
      moveChildBefore: vi.fn(() => of(receipt(...expected))),
    });

    cmp.move('!b:hs', 'up');
    await setItems([expected[0], INITIAL[0], INITIAL[2]]);
    cmp.toggleSuggested('!a:hs', true);
    expect(setSuggested).not.toHaveBeenCalled();

    await setItems(expected);
    cmp.toggleSuggested('!a:hs', true);
    expect(setSuggested).toHaveBeenCalledWith(TARGET, '!a:hs', true);
  });

  it('matches receipts against authoritative links omitted from hierarchy rows', async () => {
    const hidden = item('!hidden:hs', 'Hidden', { order: '6' });
    const expected = [
      { ...INITIAL[1], order: '2' },
      { ...INITIAL[0], order: '4' },
      hidden,
    ];
    const { cmp, setSuggested, setLinks } = await build({
      items: INITIAL.slice(0, 2),
      moveChildBefore: vi.fn(() => of(receipt(...expected))),
    });

    cmp.move('!b:hs', 'up');
    await setLinks(linksOf(...expected));
    cmp.toggleSuggested('!a:hs', true);

    expect(setSuggested).toHaveBeenCalledWith(TARGET, '!a:hs', true);
  });

  it('keeps an optimistic Suggested value only until rejection, then offers the same retry', async () => {
    const rejected = new Subject<SpaceChildWriteReceipt>();
    const setSuggested = vi
      .fn()
      .mockReturnValueOnce(rejected.asObservable())
      .mockReturnValueOnce(of(receipt({ ...INITIAL[0], suggested: true })));
    const { cmp, fixture } = await build({ setSuggested });

    cmp.toggleSuggested('!a:hs', true);
    expect(cmp.visibleItems()[0].suggested).toBe(true);
    rejected.error(new Error('forbidden'));
    await fixture.whenStable();

    expect(cmp.visibleItems()[0].suggested).toBe(false);
    expect(cmp.failure()?.message).toContain('forbidden');
    cmp.retry();
    expect(setSuggested).toHaveBeenNthCalledWith(2, TARGET, '!a:hs', true);
  });

  it('rolls the rendered checkbox back after an asynchronous refusal', async () => {
    const rejected = new Subject<SpaceChildWriteReceipt>();
    const { container, fixture } = await build({
      setSuggested: vi.fn(() => rejected.asObservable()),
    });
    const checkbox = container.querySelector<HTMLElement>(
      '[data-testid="space-content-suggest-!a:hs"] [role="checkbox"]',
    ) as HTMLElement;

    checkbox.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(checkbox.getAttribute('aria-checked')).toBe('true');

    rejected.error(new Error('forbidden'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
  });

  it('retains a rejected move and recomputes its destination when retried', async () => {
    const moveChildBefore = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('rate limited')))
      .mockReturnValueOnce(of(receipt({ ...INITIAL[1], order: 'moved' })));
    const { cmp } = await build({ moveChildBefore });

    cmp.move('!b:hs', 'down');
    expect(cmp.failure()?.message).toContain('rate limited');
    cmp.retry();

    expect(moveChildBefore).toHaveBeenNthCalledWith(2, TARGET, '!b:hs', null);
  });

  it('keeps contents inspectable but removes every command for an ordinary member', async () => {
    const { container } = await build({
      canManage: false,
      items: [item('!a:hs', 'Alpha', { suggested: true })],
    });

    expect(container.textContent).toContain('Alpha');
    expect(container.textContent).toContain('Suggested');
    expect(
      container.querySelector('[data-testid^="space-content-suggest-"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid^="space-content-move-"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid^="space-content-unlink-"]'),
    ).toBeNull();
  });

  it('stops an in-flight write and rejects further input after live permission loss', async () => {
    const pending = new Subject<SpaceChildWriteReceipt>();
    const { cmp, fixture, setSuggested } = await build({
      setSuggested: vi.fn(() => pending.asObservable()),
    });

    cmp.toggleSuggested('!a:hs', true);
    expect(pending.observed).toBe(true);
    fixture.componentRef.setInput('canManage', false);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(pending.observed).toBe(false);
    cmp.toggleSuggested('!a:hs', true);
    expect(setSuggested).toHaveBeenCalledTimes(1);
    expect(cmp.visibleItems()[0].suggested).toBe(false);
  });

  it('stops an in-flight write when the immutable target is replaced', async () => {
    const pending = new Subject<SpaceChildWriteReceipt>();
    const { cmp, fixture } = await build({
      setSuggested: vi.fn(() => pending.asObservable()),
    });

    cmp.toggleSuggested('!a:hs', true);
    fixture.componentRef.setInput('target', {
      accountId: '@other:hs',
      spaceId: '!other:hs',
    });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(pending.observed).toBe(false);
    expect(cmp.visibleItems()[0].suggested).toBe(false);
  });
});
