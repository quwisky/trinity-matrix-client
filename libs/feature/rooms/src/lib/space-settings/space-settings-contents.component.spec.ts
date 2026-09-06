import { render } from '@trinity/testing';
import { TrnAlertService } from '@trinity/components/overlay';
import {
  SpaceContentsService,
  type CreateSpaceContentResult,
  type SpaceContentsSnapshot,
} from '@trinity/data-access/room-library';
import { MockProvider } from 'ng-mocks';
import { BehaviorSubject, Subject, of, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { SpaceSettingsContentsComponent } from './space-settings-contents.component';

const TARGET = { accountId: '@opening:hs', spaceId: '!space:hs' } as const;

function snapshot(
  over: Partial<SpaceContentsSnapshot> = {},
): SpaceContentsSnapshot {
  return {
    target: TARGET,
    availability: 'available',
    unavailableReason: null,
    items: [
      {
        id: '!room:hs',
        name: 'Design room',
        initial: 'D',
        avatarMxc: null,
        kind: 'room',
        joined: true,
        via: ['hs'],
      },
      {
        id: '!nested:hs',
        name: 'Nested Space',
        initial: 'N',
        avatarMxc: null,
        kind: 'space',
        joined: false,
        via: ['hs'],
      },
    ],
    candidates: [
      {
        id: '!candidate:hs',
        name: 'Candidate',
        initial: 'C',
        avatarMxc: null,
        kind: 'room',
        joined: true,
        via: [],
        direct: false,
      },
    ],
    canManage: true,
    managementUnavailableReason: null,
    hierarchyError: null,
    ...over,
  };
}

async function build(initial = snapshot()) {
  const states = new BehaviorSubject(initial);
  const prompt = new Subject<string | null>();
  const confirm = new Subject<boolean>();
  const link = vi.fn(() => of(undefined));
  const unlink = vi.fn(() => of(undefined));
  const create = vi.fn<() => Observable<CreateSpaceContentResult>>(() =>
    of({
      kind: 'linked' as const,
      item: { id: '!new:hs', name: 'New Room', kind: 'room' as const },
    }),
  );
  const read = vi.fn(() => of(states.value));
  const { fixture, container } = await render(SpaceSettingsContentsComponent, {
    inputs: {
      target: TARGET,
      spaceName: 'Design',
    },
    providers: [
      MockProvider(SpaceContentsService, {
        observe: () => states.asObservable(),
        read,
        link,
        unlink,
        create,
      }),
      MockProvider(TrnAlertService, {
        prompt$: () => prompt.asObservable(),
        confirm$: () => confirm.asObservable(),
      }),
    ],
  });
  return {
    cmp: fixture.componentInstance,
    fixture,
    container,
    states,
    prompt,
    confirm,
    link,
    unlink,
    create,
    read,
  };
}

describe('SpaceSettingsContentsComponent', () => {
  it('shows Room and Space identity, type, and membership state', async () => {
    const { container } = await build();

    expect(container.textContent).toContain('Design room');
    expect(container.textContent).toContain('Nested Space');
    expect(container.textContent).toContain('Room');
    expect(container.textContent).toContain('Not joined');
  });

  it('keeps contents readable and removes every management action after permission loss', async () => {
    const { fixture, container, states, cmp, prompt, create } = await build();

    create.mockReturnValueOnce(
      of({
        kind: 'created-unlinked' as const,
        item: {
          id: '!orphan:hs',
          name: 'Recovered Room',
          kind: 'room' as const,
        },
        reason: 'link rejected',
      }),
    );
    cmp.create('room');
    prompt.next('Recovered Room');
    await fixture.whenStable();
    expect(
      container.querySelector('[data-testid="space-contents-retry-link"]'),
    ).not.toBeNull();

    states.next(
      snapshot({
        canManage: false,
        managementUnavailableReason: 'You need permission.',
      }),
    );
    await fixture.whenStable();

    expect(container.textContent).toContain('Design room');
    expect(
      container.querySelector('[data-testid="space-contents-actions"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid^="space-content-unlink-"]'),
    ).toBeNull();
    expect(container.textContent).toContain('Recovered Room still exists');
    expect(
      container.querySelector('[data-testid="space-contents-retry-link"]'),
    ).toBeNull();
    expect(container.textContent).toContain('your role cannot change them');
  });

  it('searches joined candidates and links the selected exact item', async () => {
    const { cmp, link } = await build();

    cmp.openPicker();
    cmp.search.query().value.set('candidate');
    cmp.toggle('!candidate:hs', true);
    cmp.addSelected();

    expect(link).toHaveBeenCalledWith(TARGET, '!candidate:hs');
    expect(cmp.feedback()?.message).toContain('Candidate added');
  });

  it('cancels creation without issuing any command', async () => {
    const { cmp, prompt, create } = await build();

    cmp.create('room');
    prompt.next(null);

    expect(create).not.toHaveBeenCalled();
  });

  it('identifies a created-but-unlinked item and retries only its link', async () => {
    const { cmp, prompt, create, link } = await build();
    create.mockReturnValueOnce(
      of({
        kind: 'created-unlinked' as const,
        item: {
          id: '!orphan:hs',
          name: 'Recovered Space',
          kind: 'space' as const,
        },
        reason: 'link rejected',
      }),
    );

    cmp.create('space');
    prompt.next('Recovered Space');
    cmp.retryLink();

    expect(cmp.feedback()?.message).toContain('without creating another Space');
    expect(create).toHaveBeenCalledTimes(1);
    expect(link).toHaveBeenCalledWith(TARGET, '!orphan:hs');
    expect(cmp.recovery()).toBeNull();
  });

  it('names parent and child before unlinking and cancellation changes nothing', async () => {
    const { cmp, confirm, unlink } = await build();
    const item = snapshot().items[0];

    cmp.unlink(item);
    confirm.next(false);
    expect(unlink).not.toHaveBeenCalled();

    cmp.unlink(item);
    confirm.next(true);
    expect(unlink).toHaveBeenCalledWith(TARGET, item.id);
    expect(cmp.feedback()?.message).toContain('Membership was not changed');
  });

  it('distinguishes an empty Space from a failed hierarchy read', async () => {
    const { container, fixture, states } = await build(snapshot({ items: [] }));
    expect(container.textContent).toContain('This Space is empty');

    states.next(snapshot({ items: [], hierarchyError: 'server unavailable' }));
    await fixture.whenStable();

    expect(container.textContent).toContain(
      'Space contents could not be loaded',
    );
    expect(container.textContent).not.toContain('This Space is empty');
  });
});
