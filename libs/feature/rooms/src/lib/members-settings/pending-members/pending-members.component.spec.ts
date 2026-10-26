import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import {
  RoomActionPermissionsService,
  RoomModerationService,
  type KnockRequest,
  type MemberSummary,
} from '@trinity/data-access/room-administration';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { NEVER, Subject, of, throwError, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PendingMembersComponent } from './pending-members.component';

const KEY = { accountId: '@admin:hs', roomId: '!room:hs' } as const;
const ALLOWED = { available: true, reason: null } as const;
const DENIED = { available: false, reason: 'Not allowed.' } as const;

const DANA: KnockRequest = {
  userId: '@dana:hs',
  roomDisplayName: 'Dana',
  roomInitial: 'D',
  roomAvatarMxc: null,
  reason: 'From the meetup',
};
const EVE: KnockRequest = {
  userId: '@eve:hs',
  roomDisplayName: 'Eve',
  roomInitial: 'E',
  roomAvatarMxc: null,
  reason: null,
};
const IVY: MemberSummary = {
  userId: '@ivy:hs',
  roomDisplayName: 'Ivy',
  roomInitial: 'I',
  roomAvatarMxc: null,
  powerLevel: 0,
  isCreator: false,
};

async function build(
  kind: 'requests' | 'invited',
  people: readonly (KnockRequest | MemberSummary)[],
  over: {
    canInvite?: boolean;
    canKick?: boolean;
    reason?: string | null;
    invite?: () => Observable<void>;
    kick?: () => Observable<void>;
    answer?: Observable<string | null>;
  } = {},
) {
  const inviteUser = vi.fn(over.invite ?? (() => of(undefined)));
  const kick = vi.fn(over.kick ?? (() => of(undefined)));
  const prompt = vi.fn(
    () => over.answer ?? of(over.reason === undefined ? 'spam' : over.reason),
  );
  const show = vi.fn();
  const { fixture, container } = await render(PendingMembersComponent, {
    inputs: { ...KEY, kind, people, authorityRevision: 0 },
    providers: [
      MockProvider(RoomActionPermissionsService, {
        roomFor: () => ({
          invite: over.canInvite === false ? DENIED : ALLOWED,
          curateSpace: DENIED,
        }),
        member: () => ({
          kick: over.canKick === false ? DENIED : ALLOWED,
          ban: DENIED,
          setPower: DENIED,
          myPower: 100,
          targetPower: 0,
        }),
      }),
      MockProvider(RoomModerationService, { kick }),
      MockProvider(RoomLibraryService, { inviteUser }),
      MockProvider(TrnAlertService, { prompt$: prompt }),
      MockProvider(TrnToastService, { show }),
    ],
  });
  const click = async (testId: string) => {
    container
      .querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!
      .click();
    await fixture.whenStable();
  };
  const setPeople = async (next: readonly (KnockRequest | MemberSummary)[]) => {
    fixture.componentRef.setInput('people', next);
    await fixture.whenStable();
  };
  return {
    cmp: fixture.componentInstance,
    fixture,
    container,
    inviteUser,
    kick,
    prompt,
    show,
    click,
    setPeople,
  };
}

describe('PendingMembersComponent', () => {
  it('shows each request with name, user id and quoted reason', async () => {
    const { container } = await build('requests', [DANA]);
    const row = container.querySelector(
      '[data-testid="pending-member-@dana:hs"]',
    );
    expect(row?.textContent).toContain('Dana');
    expect(row?.textContent).toContain('@dana:hs');
    expect(row?.textContent).toContain('“From the meetup”');
  });

  it('names each button with the person', async () => {
    const requests = await build('requests', [DANA]);
    const label = (testId: string) =>
      requests.container
        .querySelector(`[data-testid="${testId}"]`)
        ?.getAttribute('aria-label');
    expect(label('pending-approve')).toBe("Approve Dana's request");
    expect(label('pending-deny')).toBe("Deny Dana's request");
  });

  it('names Revoke with the person', async () => {
    const { container } = await build('invited', [IVY]);
    expect(
      container
        .querySelector('[data-testid="pending-revoke"]')
        ?.getAttribute('aria-label'),
    ).toBe("Revoke Ivy's invite");
  });

  it('Approve invites and shows Approving…', async () => {
    const { container, inviteUser, click } = await build('requests', [DANA], {
      invite: () => NEVER,
    });
    await click('pending-approve');
    expect(inviteUser).toHaveBeenCalledWith(KEY, '@dana:hs');
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="pending-approve"]',
    );
    expect(button?.textContent?.trim()).toBe('Approving…');
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('aria-label')).toBe("Approving Dana's request");
  });

  it('Deny asks first and kicks with the reason', async () => {
    const { kick, prompt, click } = await build('requests', [DANA]);
    await click('pending-deny');
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        header: "Deny Dana's request?",
        confirmText: 'Deny',
        variant: 'danger',
        placeholder: 'Reason (optional)',
      }),
    );
    expect(kick).toHaveBeenCalledWith(KEY, '@dana:hs', 'spam');
  });

  it('Deny without a reason kicks with none', async () => {
    const { kick, click } = await build('requests', [DANA], { reason: '' });
    await click('pending-deny');
    expect(kick).toHaveBeenCalledWith(KEY, '@dana:hs', undefined);
  });

  it('a cancelled Deny sends no kick', async () => {
    const { kick, click } = await build('requests', [DANA], { reason: null });
    await click('pending-deny');
    expect(kick).not.toHaveBeenCalled();
  });

  it('Revoke asks first and kicks', async () => {
    const { kick, prompt, click } = await build('invited', [IVY]);
    await click('pending-revoke');
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        header: "Revoke Ivy's invite?",
        confirmText: 'Revoke',
      }),
    );
    expect(kick).toHaveBeenCalledWith(KEY, '@ivy:hs', 'spam');
  });

  it('hides Approve without invite permission', async () => {
    const { container } = await build('requests', [DANA], { canInvite: false });
    expect(
      container.querySelector('[data-testid="pending-approve"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="pending-deny"]'),
    ).not.toBeNull();
  });

  it.each([
    ['requests', DANA, 'pending-deny'],
    ['invited', IVY, 'pending-revoke'],
  ] as const)(
    'hides %s %s without kick permission',
    async (kind, person, testId) => {
      const { container } = await build(kind, [person], { canKick: false });
      expect(container.querySelector(`[data-testid="${testId}"]`)).toBeNull();
    },
  );

  it.each([
    ['requests', DANA, 'pending-approve', "Couldn't approve Dana's request."],
    ['requests', DANA, 'pending-deny', "Couldn't deny Dana's request."],
    ['invited', IVY, 'pending-revoke', "Couldn't revoke Ivy's invite."],
  ] as const)(
    '%s failure toasts with its exact copy (case %#)',
    async (kind, person, testId, copy) => {
      const failing = () => throwError(() => new Error('nope'));
      const { container, show, click } = await build(kind, [person], {
        invite: failing,
        kick: failing,
      });
      await click(testId);
      expect(show).toHaveBeenCalledWith(
        copy,
        expect.objectContaining({ variant: 'danger' }),
      );
      expect(
        container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
          ?.disabled,
      ).toBe(false);
    },
  );

  it.each([
    ['requests', 'No one has asked to join.'],
    ['invited', 'No pending invites.'],
  ] as const)('shows the %s empty state', async (kind, copy) => {
    const { container } = await build(kind, []);
    expect(
      container.querySelector('[data-testid="pending-members-empty"]')
        ?.textContent,
    ).toContain(copy);
  });

  it('shows an avatar on each row', async () => {
    const { container } = await build('invited', [IVY]);
    expect(
      container.querySelector(
        '[data-testid="pending-member-@ivy:hs"] trn-avatar',
      ),
    ).not.toBeNull();
  });

  it.each([
    ['requests', DANA, 'pending-deny', "Couldn't deny Dana's request."],
    ['invited', IVY, 'pending-revoke', "Couldn't revoke Ivy's invite."],
  ] as const)(
    '%s: a confirm for someone handled elsewhere meanwhile sends nothing',
    async (kind, person, testId, copy) => {
      const answer = new Subject<string | null>();
      const { kick, show, click, setPeople } = await build(kind, [person], {
        answer,
      });
      await click(testId);

      await setPeople([]);
      answer.next('');

      expect(kick).not.toHaveBeenCalled();
      expect(show).toHaveBeenCalledWith(
        copy,
        expect.objectContaining({ variant: 'danger' }),
      );
    },
  );

  it('Approve for a request handled elsewhere sends nothing', async () => {
    const { cmp, inviteUser, show, setPeople } = await build('requests', [
      DANA,
    ]);
    await setPeople([EVE]);

    cmp.approve(DANA);

    expect(inviteUser).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith(
      "Couldn't approve Dana's request.",
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it("moves focus to the next row's first action once a handled row leaves", async () => {
    const { container, click, setPeople } = await build('requests', [
      DANA,
      EVE,
    ]);
    await click('pending-deny');

    await setPeople([EVE]);

    expect(document.activeElement).toBe(
      container.querySelector(
        '[data-testid="pending-member-@eve:hs"] [data-testid="pending-approve"]',
      ),
    );
  });

  it('tells its owner when the last handled row leaves', async () => {
    const { cmp, click, setPeople } = await build('requests', [DANA]);
    const emptied = vi.fn();
    cmp.listEmptied.subscribe(emptied);
    await click('pending-approve');

    await setPeople([]);

    expect(emptied).toHaveBeenCalledOnce();
  });

  it('leaves focus alone when the person had already moved it elsewhere', async () => {
    const { click, setPeople } = await build('requests', [DANA, EVE]);
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    await click('pending-deny');
    elsewhere.focus();

    await setPeople([EVE]);

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});
