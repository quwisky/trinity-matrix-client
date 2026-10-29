import { TestBed } from '@angular/core/testing';
import { SESSION_ENGINE } from '@trinity/data-access/matrix-client';
import {
  type EngineFailure,
  type EngineResult,
  engineFail,
  engineOk,
} from '@trinity/util/matrix';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  FakeContactAddressesEngine,
  type FakeContactAccount,
} from '../contract/fake-contact-addresses-engine';
import { CONTACT_ADDRESSES_ENGINE } from './contact-addresses-engine.token';
import { EmailAddressesWorkflow } from './email-addresses.workflow';

const ALICE = '@alice:example.org';
const HS = 'https://hs.example';

function setup(
  options: { live?: boolean; account?: Partial<FakeContactAccount> } = {},
) {
  const engine = new FakeContactAddressesEngine();
  if (options.live !== false) engine.signIn(ALICE, options.account);
  const accessToken = vi.fn((accountId: string) =>
    of(
      engine.accounts.has(accountId)
        ? {
            homeserverUrl: HS,
            accessToken: 'token',
            expiresAt: null,
            refreshable: false,
          }
        : null,
    ),
  );
  TestBed.configureTestingModule({
    providers: [
      EmailAddressesWorkflow,
      { provide: CONTACT_ADDRESSES_ENGINE, useValue: engine },
      { provide: SESSION_ENGINE, useValue: { accessToken } },
    ],
  });
  return Object.assign(TestBed.inject(EmailAddressesWorkflow), {
    fake: engine,
    accessToken,
  });
}

function failed(
  kind: EngineFailure['kind'],
  diagnostic: Omit<EngineFailure['diagnostic'], 'kind'> = {},
): EngineResult<never> {
  return engineFail({
    kind,
    code: 'request-failed',
    diagnostic: { kind, ...diagnostic },
  });
}

describe('EmailAddressesWorkflow.load', () => {
  it('returns email and msisdn addresses and drops other media', async () => {
    const workflow = setup({
      account: {
        threePids: [
          { medium: 'email', address: 'a@b.c' },
          { medium: 'msisdn', address: '4412' },
          { medium: 'x.other', address: 'z' },
        ],
      },
    });
    expect(await firstValueFrom(workflow.load(ALICE))).toEqual({
      kind: 'loaded',
      addresses: [
        { medium: 'email', address: 'a@b.c' },
        { medium: 'msisdn', address: '4412' },
      ],
      canChange: true,
    });
  });

  it('passes on whether the addresses may change', async () => {
    const workflow = setup({ account: { canChange: false } });
    expect(await firstValueFrom(workflow.load(ALICE))).toMatchObject({
      canChange: false,
    });
  });

  it('refuses with account-unavailable when the account is not live', async () => {
    const workflow = setup({ live: false });
    expect(await firstValueFrom(workflow.load(ALICE))).toEqual({
      kind: 'refused',
      reason: 'account-unavailable',
    });
  });

  it('maps a network failure to unreachable', async () => {
    const workflow = setup();
    vi.spyOn(workflow.fake, 'threePids').mockReturnValue(of(failed('network')));
    expect(await firstValueFrom(workflow.load(ALICE))).toEqual({
      kind: 'refused',
      reason: 'unreachable',
    });
  });
});

describe('EmailAddressesWorkflow.sendLink and resend', () => {
  const pending = {
    accountId: ALICE,
    email: 'A@b.c',
    sid: 'sid-1',
    clientSecret: 'secret-1',
    sendAttempt: 1,
  };

  it('sendLink trims the address and sends attempt 1 with a fresh secret', async () => {
    const workflow = setup();
    const request = vi.spyOn(workflow.fake, 'requestAddEmailToken');

    const result = await firstValueFrom(workflow.sendLink(ALICE, '  A@b.c '));

    const [[accountId, sent]] = request.mock.calls;
    expect(accountId).toBe(ALICE);
    expect(sent).toEqual({
      email: 'A@b.c',
      clientSecret: expect.stringMatching(/^[0-9a-f]{48}$/),
      sendAttempt: 1,
    });
    expect(result).toEqual({
      kind: 'sent',
      pending: {
        accountId: ALICE,
        email: 'A@b.c',
        sid: 'hs-sid-1',
        clientSecret: sent.clientSecret,
        sendAttempt: 1,
      },
    });
    await firstValueFrom(workflow.sendLink(ALICE, 'A@b.c'));
    expect(request.mock.calls[1][1].clientSecret).not.toBe(sent.clientSecret);
  });

  it('resend keeps the secret and bumps the attempt', async () => {
    const workflow = setup();
    const request = vi
      .spyOn(workflow.fake, 'requestAddEmailToken')
      .mockReturnValue(of(engineOk({ sid: 'sid-2' })));
    const result = await firstValueFrom(workflow.resend(pending));
    expect(request).toHaveBeenCalledWith(ALICE, {
      email: 'A@b.c',
      clientSecret: 'secret-1',
      sendAttempt: 2,
    });
    expect(result).toEqual({
      kind: 'sent',
      pending: { ...pending, sid: 'sid-2', sendAttempt: 2 },
    });
  });

  it('refuses with account-unavailable when the account is not live', async () => {
    const workflow = setup({ live: false });
    expect(await firstValueFrom(workflow.sendLink(ALICE, 'a@b.c'))).toEqual({
      kind: 'refused',
      reason: 'account-unavailable',
    });
  });

  it.each([
    ['M_THREEPID_IN_USE', 'in-use'],
    ['M_THREEPID_DENIED', 'cannot-send'],
    ['M_THREEPID_MEDIUM_NOT_SUPPORTED', 'cannot-send'],
    ['M_SERVER_NOT_TRUSTED', 'cannot-send'],
    ['M_INVALID_PARAM', 'invalid'],
    ['M_INVALID_EMAIL', 'invalid'],
    ['M_UNKNOWN', 'failed'],
    ['constructor', 'failed'],
    ['toString', 'failed'],
  ])('maps %s to %s', async (errcode, reason) => {
    const workflow = setup();
    vi.spyOn(workflow.fake, 'requestAddEmailToken').mockReturnValue(
      of(failed('http', { httpStatus: 400, errcode })),
    );
    expect(await firstValueFrom(workflow.sendLink(ALICE, 'a@b.c'))).toEqual({
      kind: 'refused',
      reason,
    });
  });

  it('sendLink passes retryAfterMs on M_LIMIT_EXCEEDED', async () => {
    const workflow = setup();
    vi.spyOn(workflow.fake, 'requestAddEmailToken').mockReturnValue(
      of(
        failed('rate-limit', {
          httpStatus: 429,
          errcode: 'M_LIMIT_EXCEEDED',
          retryAfterMs: 3000,
        }),
      ),
    );
    expect(await firstValueFrom(workflow.sendLink(ALICE, 'a@b.c'))).toEqual({
      kind: 'refused',
      reason: 'rate-limited',
      retryAfterMs: 3000,
    });
  });

  it('omits retryAfterMs when the rate limit carries none', async () => {
    const workflow = setup();
    vi.spyOn(workflow.fake, 'requestAddEmailToken').mockReturnValue(
      of(
        failed('rate-limit', { httpStatus: 429, errcode: 'M_LIMIT_EXCEEDED' }),
      ),
    );
    const result = await firstValueFrom(workflow.sendLink(ALICE, 'a@b.c'));
    expect(result).toMatchObject({ reason: 'rate-limited' });
    expect(result).not.toHaveProperty('retryAfterMs');
  });
});

describe('EmailAddressesWorkflow.add', () => {
  const pending = {
    accountId: ALICE,
    email: 'a@b.c',
    sid: 'sid-1',
    clientSecret: 'secret-1',
    sendAttempt: 1,
  };
  const uia = (stages: string[]): EngineResult<never> =>
    engineFail({
      kind: 'http',
      code: 'uia-required',
      diagnostic: { kind: 'http', httpStatus: 401 },
      params: { challenge: { session: 's', flows: [{ stages }] } },
    });
  const notOpened = () =>
    failed('http', { httpStatus: 400, errcode: 'M_THREEPID_AUTH_FAILED' });
  const stages = (password: string | null = 'pw') => ({
    password: vi.fn().mockResolvedValue(password),
    confirmInBrowser: vi.fn().mockResolvedValue(true),
  });
  const added = (
    workflow: ReturnType<typeof setup>,
    ...answers: EngineResult<null>[]
  ) => {
    const spy = vi.spyOn(workflow.fake, 'addThreePid');
    for (const answer of answers) spy.mockReturnValueOnce(of(answer));
    return spy.mockReturnValue(of(engineOk(null)));
  };

  it('adds with the pending session and no auth on the probe', async () => {
    const workflow = setup();
    const addThreePid = added(workflow);
    const result = await firstValueFrom(workflow.add(pending, stages()));
    expect(result).toEqual({ kind: 'added' });
    expect(addThreePid).toHaveBeenCalledTimes(1);
    expect(addThreePid).toHaveBeenCalledWith(
      ALICE,
      { sid: 'sid-1', clientSecret: 'secret-1' },
      null,
    );
  });

  it('uses the pending account, not the active one', async () => {
    const workflow = setup();
    workflow.fake.signIn('@bob:example.org');
    const addThreePid = added(workflow);
    await firstValueFrom(
      workflow.add({ ...pending, accountId: '@bob:example.org' }, stages()),
    );
    expect(workflow.accessToken).toHaveBeenCalledWith('@bob:example.org');
    expect(addThreePid.mock.calls[0][0]).toBe('@bob:example.org');
  });

  it('answers a password stage', async () => {
    const workflow = setup();
    const addThreePid = added(workflow, uia(['m.login.password']));
    const result = await firstValueFrom(workflow.add(pending, stages()));
    expect(result).toEqual({ kind: 'added' });
    expect(addThreePid.mock.calls[1][2]).toEqual({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: ALICE },
      password: 'pw',
      session: 's',
    });
  });

  it('answers not-verified with the pending email when the link was not opened', async () => {
    const workflow = setup();
    vi.spyOn(workflow.fake, 'addThreePid').mockReturnValue(of(notOpened()));
    expect(await firstValueFrom(workflow.add(pending, stages()))).toEqual({
      kind: 'not-verified',
      pending,
    });
  });

  it('reuses the completed session once the link is opened', async () => {
    const workflow = setup();
    const addThreePid = added(workflow, uia(['m.login.password']), notOpened());
    const s = stages();

    const first = await firstValueFrom(workflow.add(pending, s));
    expect(first).toEqual({
      kind: 'not-verified',
      pending: { ...pending, uiaSession: 's' },
    });
    if (first.kind !== 'not-verified') return;

    const second = await firstValueFrom(workflow.add(first.pending, s));
    expect(second).toEqual({ kind: 'added' });
    expect(addThreePid.mock.calls[2][2]).toEqual({ session: 's' });
    expect(s.password).toHaveBeenCalledTimes(1);
  });

  it('asks again when the remembered session has expired', async () => {
    const workflow = setup();
    const addThreePid = added(workflow, uia(['m.login.password']));
    const s = stages();
    const result = await firstValueFrom(
      workflow.add({ ...pending, uiaSession: 'expired' }, s),
    );
    expect(result).toEqual({ kind: 'added' });
    expect(addThreePid.mock.calls[0][2]).toEqual({ session: 'expired' });
    expect(addThreePid.mock.calls[1][2]).toMatchObject({
      type: 'm.login.password',
      session: 's',
    });
    expect(s.password).toHaveBeenCalledTimes(1);
  });

  it('maps a cancelled prompt to cancelled', async () => {
    const workflow = setup();
    vi.spyOn(workflow.fake, 'addThreePid').mockReturnValue(
      of(uia(['m.login.password'])),
    );
    expect(await firstValueFrom(workflow.add(pending, stages(null)))).toEqual({
      kind: 'refused',
      reason: 'cancelled',
    });
  });

  it('opens the homeserver’s fallback page for a non-password stage', async () => {
    const workflow = setup();
    added(workflow, uia(['m.login.sso']));
    const s = stages();
    const result = await firstValueFrom(workflow.add(pending, s));
    expect(result).toEqual({ kind: 'added' });
    expect(s.confirmInBrowser).toHaveBeenCalledWith({
      url: `${HS}/_matrix/client/v3/auth/m.login.sso/fallback/web?session=s`,
      pending: false,
    });
  });

  it('flags the fallback step pending when the server repeats the stage', async () => {
    const workflow = setup();
    added(workflow, uia(['m.login.sso']), uia(['m.login.sso']));
    const s = stages();
    await firstValueFrom(workflow.add(pending, s));
    expect(s.confirmInBrowser.mock.calls.map(([step]) => step.pending)).toEqual(
      [false, true],
    );
  });

  it('maps a challenge with no stage left to no-usable-stage', async () => {
    const workflow = setup();
    vi.spyOn(workflow.fake, 'addThreePid').mockReturnValue(of(uia([])));
    expect(await firstValueFrom(workflow.add(pending, stages()))).toEqual({
      kind: 'refused',
      reason: 'no-usable-stage',
    });
  });

  it('maps repeated rejected passwords to attempts-exceeded', async () => {
    const workflow = setup();
    vi.spyOn(workflow.fake, 'addThreePid').mockReturnValue(
      of(uia(['m.login.password'])),
    );
    expect(await firstValueFrom(workflow.add(pending, stages()))).toEqual({
      kind: 'refused',
      reason: 'attempts-exceeded',
    });
  });

  it('refuses with account-unavailable when the account is not live', async () => {
    const workflow = setup({ live: false });
    expect(await firstValueFrom(workflow.add(pending, stages()))).toEqual({
      kind: 'refused',
      reason: 'account-unavailable',
    });
  });

  it('refuses with account-unavailable when the account goes during the add', async () => {
    const workflow = setup();
    workflow.accessToken.mockReturnValue(
      of({
        homeserverUrl: HS,
        accessToken: 'token',
        expiresAt: null,
        refreshable: false,
      }),
    );
    workflow.fake.accounts.delete(ALICE);
    expect(await firstValueFrom(workflow.add(pending, stages()))).toEqual({
      kind: 'refused',
      reason: 'account-unavailable',
    });
  });
});

describe('EmailAddressesWorkflow.remove', () => {
  const address = { medium: 'email', address: 'a@b.c' } as const;

  it('deletes by medium and address, reporting an address no server unbound', async () => {
    const workflow = setup({ account: { threePids: [{ ...address }] } });
    expect(await firstValueFrom(workflow.remove(ALICE, address))).toEqual({
      kind: 'removed',
      unbind: 'no-support',
    });
    expect(workflow.fake.accounts.get(ALICE)?.threePids).toEqual([]);
  });

  it('passes a successful unbind through', async () => {
    const workflow = setup({ account: { threePids: [{ ...address }] } });
    workflow.fake.bindings.set(`is.example\n${address.address}`, ALICE);
    expect(await firstValueFrom(workflow.remove(ALICE, address))).toEqual({
      kind: 'removed',
      unbind: 'success',
    });
  });

  it('maps a failure to failed', async () => {
    const workflow = setup();
    vi.spyOn(workflow.fake, 'deleteThreePid').mockReturnValue(
      of(failed('server', { httpStatus: 500, errcode: 'M_UNKNOWN' })),
    );
    expect(await firstValueFrom(workflow.remove(ALICE, address))).toEqual({
      kind: 'refused',
      reason: 'failed',
    });
  });

  it('changes nothing until subscribed', async () => {
    const workflow = setup({ account: { threePids: [{ ...address }] } });
    const result$ = workflow.remove(ALICE, address);
    expect(workflow.fake.accounts.get(ALICE)?.threePids).toHaveLength(1);
    await firstValueFrom(result$);
    expect(workflow.fake.accounts.get(ALICE)?.threePids).toEqual([]);
  });
});
