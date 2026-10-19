import { type MemberSummary } from '@trinity/data-access/room-administration';
import { type PresenceDetails } from '@trinity/data-access/identity';
import { type UserTrust } from '@trinity/data-access/trust';
import { TrnToastService } from '@trinity/components/overlay';
import { render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemberProfileTabComponent } from './member-profile-tab.component';

const BOB: MemberSummary = {
  userId: '@bob:hs',
  roomDisplayName: 'Bob',
  roomInitial: 'B',
  roomAvatarMxc: null,
  powerLevel: 0,
  isCreator: false,
};

function presence(over: Partial<PresenceDetails> = {}): PresenceDetails {
  return {
    state: 'online',
    statusMessage: '',
    lastActiveAt: null,
    currentlyActive: true,
    ...over,
  };
}

async function build(
  inputs: {
    isSelf?: boolean;
    trust?: UserTrust | null;
    presence?: PresenceDetails | null;
    globalName?: string | null;
    showIdentityActions?: boolean;
  } = {},
) {
  const toastShow = vi.fn();
  const message = vi.fn();
  const verify = vi.fn();
  const copyFailed = vi.fn();
  const { fixture, container } = await render(MemberProfileTabComponent, {
    inputs: {
      member: BOB,
      isSelf: inputs.isSelf ?? false,
      trust: inputs.trust ?? null,
      presence: inputs.presence ?? null,
      globalName: inputs.globalName ?? null,
      showIdentityActions: inputs.showIdentityActions ?? true,
    },
    on: { messageUser: message, verify, copyFailed },
    providers: [MockProvider(TrnToastService, { show: toastShow })],
  });
  return {
    cmp: fixture.componentInstance,
    fixture,
    container,
    toastShow,
    message,
    verify,
    copyFailed,
  };
}

const byTestId = (container: Element, id: string) =>
  container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const FALLBACK =
  'Could not copy the user ID. It is selected above; copy it manually.';

describe('MemberProfileTabComponent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('Message, Copy ID and Verify for an unverified person', async () => {
    const { container, message, verify } = await build({
      trust: 'unverified',
    });

    screen.getByRole('button', { name: 'Message' }).click();
    screen.getByRole('button', { name: 'Verify' }).click();

    expect(screen.getByRole('button', { name: 'Copy ID' })).toBe(
      byTestId(container, 'member-info-copy'),
    );
    expect(byTestId(container, 'member-info-message')).not.toBeNull();
    expect(byTestId(container, 'member-info-verify')).not.toBeNull();
    expect(message).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
  });

  it.each(['changed', null] as const)(
    'offers Verify when trust is %s',
    async (trust) => {
      const { container } = await build({ trust });
      expect(byTestId(container, 'member-info-verify')).not.toBeNull();
    },
  );

  it('no Verify when verified', async () => {
    const { container } = await build({ trust: 'verified' });
    expect(byTestId(container, 'member-info-verify')).toBeNull();
  });

  it('no Verify without identity actions', async () => {
    const { container } = await build({ showIdentityActions: false });
    expect(byTestId(container, 'member-info-verify')).toBeNull();
  });

  it('no Message or Verify for yourself', async () => {
    const { container } = await build({ isSelf: true });
    expect(byTestId(container, 'member-info-message')).toBeNull();
    expect(byTestId(container, 'member-info-verify')).toBeNull();
    expect(byTestId(container, 'member-info-copy')).not.toBeNull();
  });

  it('Status reads "Online · On holiday"', async () => {
    const { container } = await build({
      presence: presence({ statusMessage: 'On holiday' }),
    });
    expect(byTestId(container, 'member-info-status')?.textContent?.trim()).toBe(
      'Online · On holiday',
    );
  });

  it.each([
    ['unavailable', 'Away'],
    ['offline', 'Offline'],
  ] as const)('Status for %s reads %s', async (state, text) => {
    const { container } = await build({ presence: presence({ state }) });
    expect(byTestId(container, 'member-info-status')?.textContent?.trim()).toBe(
      text,
    );
  });

  it('offline with a last active time reads "Last seen 2 hours ago"', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-19T12:00:00Z') });
    const { container } = await build({
      presence: presence({
        state: 'offline',
        currentlyActive: false,
        lastActiveAt: Date.now() - 2 * 60 * 60_000,
      }),
    });
    // The shared helper uses the short Intl style.
    expect(byTestId(container, 'member-info-status')?.textContent?.trim()).toBe(
      'Last seen 2 hr. ago',
    );
  });

  it('keeps "Last seen" current as time passes', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-19T12:00:00Z') });
    const { container, fixture } = await build({
      presence: presence({
        state: 'offline',
        currentlyActive: false,
        lastActiveAt: Date.now() - 5 * 60_000,
      }),
    });

    vi.advanceTimersByTime(60_000);
    fixture.detectChanges();

    expect(byTestId(container, 'member-info-status')?.textContent?.trim()).toBe(
      'Last seen 6 min. ago',
    );
  });

  it('Status hidden while presence is unknown', async () => {
    await build({ presence: null });
    expect(screen.queryByText('Status')).toBeNull();
  });

  it('Global name row only when it differs', async () => {
    const { container, fixture } = await build({ globalName: null });
    expect(byTestId(container, 'member-info-global-name')).toBeNull();

    fixture.componentRef.setInput('globalName', 'Robert');
    await fixture.whenStable();
    expect(
      byTestId(container, 'member-info-global-name')?.textContent?.trim(),
    ).toBe('Robert');
  });

  it('copies the user id and toasts once the write resolves', async () => {
    // The real writeText returns a Promise; the toast must follow it, not fire blind.
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { cmp, toastShow } = await build();

    cmp.copyId();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('@bob:hs');
    expect(toastShow).toHaveBeenCalledWith(
      'User ID copied.',
      expect.anything(),
    );
  });

  it('does not claim success when the clipboard write is rejected', async () => {
    // Denied permission / non-secure context. Telling the user "copied" here leaves
    // them believing they have the id when the clipboard is untouched.
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { cmp, toastShow, copyFailed } = await build();

    cmp.copyId();
    await Promise.resolve();
    await Promise.resolve();

    expect(toastShow).not.toHaveBeenCalledWith(
      'User ID copied.',
      expect.anything(),
    );
    expect(copyFailed).toHaveBeenCalledOnce();
    expect(toastShow).toHaveBeenCalledWith(
      FALLBACK,
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('offers the same manual fallback when the Clipboard API is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const { cmp, toastShow } = await build();

    cmp.copyId();
    await Promise.resolve();
    await Promise.resolve();

    expect(toastShow).toHaveBeenCalledWith(
      FALLBACK,
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('offers the fallback when clipboard exists without writeText', async () => {
    vi.stubGlobal('navigator', { clipboard: {} });
    const { cmp, toastShow } = await build();

    expect(() => cmp.copyId()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(toastShow).toHaveBeenCalledWith(
      FALLBACK,
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('offers the fallback when writeText throws synchronously', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: () => {
          throw new Error('not available');
        },
      },
    });
    const { cmp, toastShow } = await build();

    expect(() => cmp.copyId()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(toastShow).toHaveBeenCalledWith(
      FALLBACK,
      expect.objectContaining({ variant: 'danger' }),
    );
  });
});
