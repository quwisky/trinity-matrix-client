import { RoomAliasesService } from '@trinity/data-access/room-administration';
import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of, Subject, throwError } from 'rxjs';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import { RoomActionPermissionsService } from '@trinity/data-access/room-administration';
import { RoomAliasesComponent } from './room-aliases.component';

const TARGET = { accountId: '@opening:hs', roomId: '!r:hs' } as const;

async function build(
  opts: {
    aliases?: string[];
    canonical?: string | null;
    server?: string | null;
    canManage?: boolean;
    available?: boolean;
    noun?: 'Room' | 'Space';
  } = {},
  over: {
    localAliases?: Mock;
    addAlias?: Mock;
    removeAlias?: Mock;
    setCanonicalAlias?: Mock;
    confirm?: Mock;
  } = {},
) {
  const addAlias = over.addAlias ?? vi.fn(() => of(undefined));
  const removeAlias = over.removeAlias ?? vi.fn(() => of(undefined));
  const setCanonicalAlias =
    over.setCanonicalAlias ?? vi.fn(() => of(undefined));
  const toastShow = vi.fn();
  const alertConfirm = over.confirm ?? vi.fn(() => of(true));
  const canManage = signal(opts.canManage ?? true);
  const availability = () => ({
    available: canManage(),
    reason: canManage() ? null : 'Your role cannot manage room addresses.',
  });
  const { fixture, container } = await render(RoomAliasesComponent, {
    inputs: {
      accountId: TARGET.accountId,
      roomId: TARGET.roomId,
      noun: opts.noun ?? 'Room',
      available: opts.available ?? true,
    },
    providers: [
      MockProvider(RoomAliasesService, {
        serverName: () => opts.server ?? 'hs.example',
        currentCanonical: () => opts.canonical ?? null,
        localAliases: over.localAliases ?? (() => of(opts.aliases ?? [])),
        addAlias,
        removeAlias,
        setCanonicalAlias,
      }),
      MockProvider(RoomActionPermissionsService, {
        settingsFor: () => ({
          name: availability(),
          topic: availability(),
          avatar: availability(),
          joinRule: availability(),
          history: availability(),
          aliases: availability(),
        }),
      }),
      MockProvider(TrnAlertService, { confirm$: alertConfirm }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return {
    cmp: fixture.componentInstance,
    fixture,
    container,
    addAlias,
    removeAlias,
    setCanonicalAlias,
    toastShow,
    alertConfirm,
    canManage,
  };
}

describe('RoomAliasesComponent', () => {
  it('adds the alias on Enter and swallows the event', async () => {
    // This component sits inside the settings <form>, which has a submit button, so a bare
    // Enter would implicitly submit it — saving and CLOSING the dialog without ever adding
    // the address the user just typed.
    const { cmp, addAlias } = await build();
    cmp.aliasForm.localpart().value.set('team');
    const event = { preventDefault: vi.fn() } as unknown as Event;

    cmp.onEnter(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(addAlias).toHaveBeenCalledWith(TARGET, '#team:hs.example');
  });

  it('loads and lists the room’s local aliases on init', async () => {
    const { cmp, container } = await build({ aliases: ['#a:hs.example'] });
    expect(cmp.aliases()).toEqual(['#a:hs.example']);
    expect(container.textContent).toContain('#a:hs.example');
  });

  it('loads aliases when the opening target becomes available', async () => {
    const localAliases = vi.fn(() => of(['#available:hs.example']));
    const { cmp, fixture } = await build(
      { available: false },
      { localAliases },
    );

    expect(localAliases).not.toHaveBeenCalled();

    fixture.componentRef.setInput('available', true);
    await fixture.whenStable();

    expect(localAliases).toHaveBeenCalledOnce();
    expect(localAliases).toHaveBeenCalledWith(TARGET);
    expect(cmp.aliases()).toEqual(['#available:hs.example']);
  });

  it('shows the empty state when the room has no addresses', async () => {
    const { container } = await build({ aliases: [] });
    expect(
      container.querySelector('[data-testid=room-aliases-empty]'),
    ).not.toBeNull();
  });

  it('adds a `#localpart:server` alias, appends it, and toasts', async () => {
    const { cmp, addAlias, toastShow } = await build({ aliases: [] });
    cmp.aliasForm.localpart().value.set('lounge');

    cmp.add();

    expect(addAlias).toHaveBeenCalledWith(TARGET, '#lounge:hs.example');
    expect(cmp.aliases()).toEqual(['#lounge:hs.example']);
    expect(cmp.aliasForm.localpart().value()).toBe('');
    expect(toastShow).toHaveBeenCalledWith(
      'Added #lounge:hs.example.',
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('rejects an invalid localpart without calling the service', async () => {
    const { cmp, addAlias, toastShow } = await build();
    cmp.aliasForm.localpart().value.set('has spaces');

    cmp.add();

    expect(addAlias).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('rejects a duplicate alias without calling the service', async () => {
    const { cmp, addAlias, toastShow } = await build({
      aliases: ['#dup:hs.example'],
    });
    cmp.aliasForm.localpart().value.set('dup');

    cmp.add();

    expect(addAlias).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('already exists'),
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('removes an alias, drops it from the list, and clears it as canonical', async () => {
    const { cmp, removeAlias, toastShow } = await build({
      aliases: ['#a:hs.example'],
      canonical: '#a:hs.example',
    });

    cmp.remove('#a:hs.example');

    expect(removeAlias).toHaveBeenCalledWith(TARGET, '#a:hs.example');
    expect(cmp.aliases()).toEqual([]);
    expect(cmp.canonical()).toBeNull(); // it was the main address
    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('Removed'),
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('sets an alias as the main address', async () => {
    const { cmp, setCanonicalAlias } = await build({
      aliases: ['#a:hs.example', '#b:hs.example'],
    });

    cmp.setPrimary('#b:hs.example');

    expect(setCanonicalAlias).toHaveBeenCalledWith(TARGET, '#b:hs.example');
    expect(cmp.canonical()).toBe('#b:hs.example');
  });

  it('keeps aliases readable while removing every administration action live', async () => {
    const { cmp, container, fixture, canManage, addAlias, removeAlias } =
      await build({ aliases: ['#a:hs.example', '#b:hs.example'] });
    cmp.aliasForm.localpart().value.set('draft');

    canManage.set(false);
    await fixture.whenStable();

    expect(container.textContent).toContain('#a:hs.example');
    expect(cmp.aliasForm.localpart().value()).toBe('draft');
    expect(
      container.querySelector('[data-testid=room-aliases-read-only]')
        ?.textContent,
    ).toContain('Your role cannot manage room addresses.');
    for (const testId of [
      'room-alias-input',
      'room-alias-add',
      'room-alias-set-main',
      'room-alias-remove',
    ]) {
      expect(container.querySelector(`[data-testid=${testId}]`)).toBeNull();
    }
    expect(
      container.querySelector('[data-testid=room-alias-copy]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid=room-alias-link]'),
    ).not.toBeNull();

    cmp.add();
    cmp.remove('#a:hs.example');
    expect(addAlias).not.toHaveBeenCalled();
    expect(removeAlias).not.toHaveBeenCalled();
  });

  it('uses Space language in the read-only explanation', async () => {
    const { container } = await build({
      aliases: ['#community:hs.example'],
      noun: 'Space',
      canManage: false,
    });

    expect(
      container.querySelector('[data-testid=room-aliases-read-only]')
        ?.textContent,
    ).toContain(
      "The opening Account cannot currently manage this Space's addresses.",
    );
  });

  it('keeps the alias listed and toasts when removal fails', async () => {
    const removeAlias = vi.fn(() => throwError(() => new Error('nope')));
    const { cmp, toastShow } = await build(
      { aliases: ['#a:hs.example'] },
      { removeAlias },
    );

    cmp.remove('#a:hs.example');

    expect(cmp.aliases()).toEqual(['#a:hs.example']); // unchanged on failure
    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('Could not remove'),
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('preserves the entered local address when creation fails', async () => {
    const addAlias = vi.fn(() => throwError(() => new Error('rejected')));
    const { cmp, toastShow } = await build({}, { addAlias });
    cmp.aliasForm.localpart().value.set('correct-me');

    cmp.add();

    expect(cmp.aliasForm.localpart().value()).toBe('correct-me');
    expect(toastShow).toHaveBeenCalledWith(
      'Could not add #correct-me:hs.example.',
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('reports primary-address progress and failure independently', async () => {
    const result = new Subject<void>();
    const setCanonicalAlias = vi.fn(() => result.asObservable());
    const { cmp, fixture, container, toastShow } = await build(
      { aliases: ['#a:hs.example'] },
      { setCanonicalAlias },
    );

    cmp.setPrimary('#a:hs.example');
    await fixture.whenStable();

    expect(cmp.settingPrimary()).toBe('#a:hs.example');
    expect(
      container
        .querySelector('[data-testid=room-alias-set-main]')
        ?.getAttribute('aria-busy'),
    ).toBe('true');

    result.error(new Error('rejected'));
    expect(cmp.settingPrimary()).toBeNull();
    expect(toastShow).toHaveBeenCalledWith(
      'Could not make #a:hs.example the primary address.',
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('names the exact Space address and joining effect, then honours cancellation', async () => {
    const confirm = vi.fn(() => of(false));
    const { cmp, alertConfirm, removeAlias } = await build(
      { aliases: ['#community:hs.example'], noun: 'Space' },
      { confirm },
    );

    cmp.remove('#community:hs.example');

    expect(alertConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        header: 'Remove #community:hs.example?',
        message: expect.stringMatching(
          /join or link to this space.*does not delete the Space/,
        ),
      }),
    );
    expect(removeAlias).not.toHaveBeenCalled();
  });

  it('rechecks permission after removal confirmation', async () => {
    const answer = new Subject<boolean>();
    const confirm = vi.fn(() => answer.asObservable());
    const { cmp, canManage, removeAlias } = await build(
      { aliases: ['#a:hs.example'] },
      { confirm },
    );
    cmp.remove('#a:hs.example');

    canManage.set(false);
    answer.next(true);
    answer.complete();

    expect(removeAlias).not.toHaveBeenCalled();
  });

  it('ignores a late address load after the exact target changes', async () => {
    const oldLoad = new Subject<string[]>();
    const localAliases = vi.fn((target: { accountId: string }) =>
      target.accountId === TARGET.accountId
        ? oldLoad.asObservable()
        : of(['#second:hs.example']),
    );
    const { cmp, fixture } = await build({}, { localAliases });

    fixture.componentRef.setInput('accountId', '@second:hs');
    await fixture.whenStable();
    oldLoad.next(['#stale:hs.example']);

    expect(cmp.aliases()).toEqual(['#second:hs.example']);
  });

  it('shows a canonical address even when it is not a local alias', async () => {
    const alias = '#remote:elsewhere.example';
    const { container } = await build({
      aliases: [],
      canonical: alias,
    });

    expect(
      container.querySelector('[data-testid=room-alias-primary]')?.textContent,
    ).toContain(alias);
    expect(container.textContent).not.toContain('no published addresses');
    expect(
      container.querySelector('[data-testid=room-aliases-local-empty]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid=room-alias-primary-copy]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid=room-alias-primary-link]')
        ?.getAttribute('href'),
    ).toBe(`https://matrix.to/#/${encodeURIComponent(alias)}`);
  });

  it('copies the full address and exposes its encoded Matrix link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const alias = '#a very long address:hs.example';
    const { cmp, container, toastShow } = await build({ aliases: [alias] });
    const address = container.querySelector<HTMLElement>(
      '[data-testid=room-alias-value]',
    )!;

    cmp.copy(alias, address);
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith(alias);
    expect(toastShow).toHaveBeenCalledWith(
      'Address copied.',
      expect.anything(),
    );
    expect(
      container
        .querySelector('[data-testid=room-alias-link]')
        ?.getAttribute('href'),
    ).toBe(`https://matrix.to/#/${encodeURIComponent(alias)}`);
  });
});

afterEach(() => vi.unstubAllGlobals());
