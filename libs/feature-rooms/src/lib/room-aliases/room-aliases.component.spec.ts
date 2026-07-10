import { render } from '@testing-library/angular';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TrnToastService } from '@trinity/helm/overlay';
import { RoomAliasesService } from '@trinity/data-access-rooms';
import { RoomAliasesComponent } from './room-aliases.component';

async function build(
  opts: {
    aliases?: string[];
    canonical?: string | null;
    server?: string | null;
  } = {},
  over: {
    addAlias?: ReturnType<typeof vi.fn>;
    removeAlias?: ReturnType<typeof vi.fn>;
    setCanonicalAlias?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const addAlias = over.addAlias ?? vi.fn(() => of(undefined));
  const removeAlias = over.removeAlias ?? vi.fn(() => of(undefined));
  const setCanonicalAlias =
    over.setCanonicalAlias ?? vi.fn(() => of(undefined));
  const toastShow = vi.fn();
  const { fixture, container } = await render(RoomAliasesComponent, {
    inputs: { roomId: '!r:hs' },
    providers: [
      MockProvider(RoomAliasesService, {
        serverName: () => opts.server ?? 'hs.example',
        currentCanonical: () => opts.canonical ?? null,
        localAliases: () => of(opts.aliases ?? []),
        addAlias,
        removeAlias,
        setCanonicalAlias,
      }),
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
  };
}

describe('RoomAliasesComponent', () => {
  it('loads and lists the room’s local aliases on init', async () => {
    const { cmp, container } = await build({ aliases: ['#a:hs.example'] });
    expect(cmp.aliases()).toEqual(['#a:hs.example']);
    expect(container.textContent).toContain('#a:hs.example');
  });

  it('shows the empty state when the room has no addresses', async () => {
    const { container } = await build({ aliases: [] });
    expect(
      container.querySelector('[data-testid=room-aliases-empty]'),
    ).not.toBeNull();
  });

  it('adds a `#localpart:server` alias, appends it, and toasts', async () => {
    const { cmp, addAlias, toastShow } = await build({ aliases: [] });
    cmp.newLocalpart.setValue('lounge');

    cmp.add();

    expect(addAlias).toHaveBeenCalledWith('!r:hs', '#lounge:hs.example');
    expect(cmp.aliases()).toEqual(['#lounge:hs.example']);
    expect(cmp.newLocalpart.value).toBe('');
    expect(toastShow).toHaveBeenCalledWith(
      'Added #lounge:hs.example.',
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('rejects an invalid localpart without calling the service', async () => {
    const { cmp, addAlias, toastShow } = await build();
    cmp.newLocalpart.setValue('has spaces');

    cmp.add();

    expect(addAlias).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('rejects a duplicate alias without calling the service', async () => {
    const { cmp, addAlias, toastShow } = await build({
      aliases: ['#dup:hs.example'],
    });
    cmp.newLocalpart.setValue('dup');

    cmp.add();

    expect(addAlias).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('already exists'),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('removes an alias, drops it from the list, and clears it as canonical', async () => {
    const { cmp, removeAlias, toastShow } = await build({
      aliases: ['#a:hs.example'],
      canonical: '#a:hs.example',
    });

    cmp.remove('#a:hs.example');

    expect(removeAlias).toHaveBeenCalledWith('#a:hs.example');
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

    cmp.setMain('#b:hs.example');

    expect(setCanonicalAlias).toHaveBeenCalledWith('!r:hs', '#b:hs.example');
    expect(cmp.canonical()).toBe('#b:hs.example');
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
      expect.objectContaining({ variant: 'destructive' }),
    );
  });
});
