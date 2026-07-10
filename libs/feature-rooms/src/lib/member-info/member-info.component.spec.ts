import { signal } from '@angular/core';
import { render } from '@testing-library/angular';
import { DialogRef, TrnToastService } from '@trinity/helm/overlay';
import { PresenceService } from '@trinity/data-access-profile';
import { type MemberSummary } from '@trinity/data-access-rooms';
import { MockProvider } from 'ng-mocks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemberInfoComponent } from './member-info.component';

function member(over: Partial<MemberSummary> = {}): MemberSummary {
  return {
    userId: '@bob:hs',
    name: 'Bob',
    initial: 'B',
    avatarMxc: null,
    powerLevel: 0,
    ...over,
  };
}

async function build(m: MemberSummary = member()) {
  const close = vi.fn();
  const toastShow = vi.fn();
  const { fixture, container } = await render(MemberInfoComponent, {
    inputs: { member: m, roomId: '!r:hs' },
    providers: [
      MockProvider(DialogRef, { close }),
      MockProvider(TrnToastService, { show: toastShow }),
      {
        provide: PresenceService,
        useValue: { presenceFor: () => signal('online') },
      },
    ],
  });
  return { cmp: fixture.componentInstance, container, close, toastShow };
}

describe('MemberInfoComponent', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the member name, id, and role', async () => {
    const { container } = await build(member({ powerLevel: 100 }));
    expect(container.textContent).toContain('Bob');
    expect(container.textContent).toContain('@bob:hs');
    expect(container.textContent).toContain('Admin');
  });

  // One render per case (a second render() re-configures an instantiated TestBed).
  it.each([
    [100, 'Admin'],
    [50, 'Moderator'],
    [0, 'Member'],
  ] as const)('derives power %i → role %s', async (power, label) => {
    const { cmp } = await build(member({ powerLevel: power }));
    expect(cmp.role()).toBe(label);
  });

  it('closes resolving the user id when Message is picked', async () => {
    const { cmp, close } = await build();
    cmp.message();
    expect(close).toHaveBeenCalledWith('@bob:hs');
  });

  it('copies the user id and toasts', async () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { cmp, toastShow } = await build();

    cmp.copyId();

    expect(writeText).toHaveBeenCalledWith('@bob:hs');
    expect(toastShow).toHaveBeenCalled();
  });

  it('closes resolving null when dismissed', async () => {
    const { cmp, close } = await build();
    cmp.close();
    expect(close).toHaveBeenCalledWith(null);
  });
});
