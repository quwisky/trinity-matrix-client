import { render } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import { RoomAliasRowComponent } from './room-alias-row.component';

const base = {
  alias: '#a:hs.example',
  primary: false,
  canEdit: true,
  removing: false,
  confirming: false,
};

const byId = (container: Element, id: string) =>
  container.querySelector(`[data-testid=${id}]`) as HTMLElement | null;

describe('RoomAliasRowComponent', () => {
  it('shows the address, its encoded matrix.to link and a Primary badge', async () => {
    const { container } = await render(RoomAliasRowComponent, {
      inputs: { ...base, alias: '#a b:hs.example', primary: true },
    });

    expect(byId(container, 'room-alias-value')?.textContent).toBe(
      '#a b:hs.example',
    );
    expect(byId(container, 'room-alias-link')?.getAttribute('href')).toBe(
      'https://matrix.to/#/%23a%20b%3Ahs.example',
    );
    expect(byId(container, 'room-alias-main')).not.toBeNull();
    // The primary address is already primary, so it cannot be made primary again.
    expect(byId(container, 'room-alias-set-main')).toBeNull();
  });

  it('keeps Copy and Open link but drops the edit actions when read-only', async () => {
    const { container } = await render(RoomAliasRowComponent, {
      inputs: { ...base, canEdit: false },
    });

    expect(byId(container, 'room-alias-copy')).not.toBeNull();
    expect(byId(container, 'room-alias-link')).not.toBeNull();
    expect(byId(container, 'room-alias-set-main')).toBeNull();
    expect(byId(container, 'room-alias-remove')).toBeNull();
  });

  it('emits copyAddress with the address element, setPrimary and remove', async () => {
    const copyAddress = vi.fn();
    const setPrimary = vi.fn();
    const remove = vi.fn();
    const { container } = await render(RoomAliasRowComponent, {
      inputs: base,
      on: { copyAddress, setPrimary, remove },
    });

    byId(container, 'room-alias-copy')?.click();
    byId(container, 'room-alias-set-main')?.click();
    byId(container, 'room-alias-remove')?.click();

    expect(copyAddress).toHaveBeenCalledWith(
      byId(container, 'room-alias-value'),
    );
    expect(setPrimary).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('labels and disables the buttons while removing or confirming', async () => {
    const { container, fixture } = await render(RoomAliasRowComponent, {
      inputs: { ...base, removing: true },
    });

    expect(byId(container, 'room-alias-remove')?.textContent).toContain(
      'Removing…',
    );
    expect(
      (byId(container, 'room-alias-set-main') as HTMLButtonElement).disabled,
    ).toBe(true);

    fixture.componentRef.setInput('removing', false);
    fixture.componentRef.setInput('confirming', true);
    fixture.detectChanges();
    expect(
      (byId(container, 'room-alias-remove') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('labels the alias being made primary', async () => {
    const { container } = await render(RoomAliasRowComponent, {
      inputs: { ...base, settingPrimary: base.alias },
    });

    expect(byId(container, 'room-alias-set-main')?.textContent).toContain(
      'Making primary…',
    );
  });
});
