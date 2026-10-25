import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ConnectionError, MatrixError } from '@trinity/util/matrix';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { EmailAddressesWorkflow } from './email-addresses.workflow';

const ALICE = '@alice:example.org';

function setup(
  options: {
    threepids?: unknown[];
    capabilities?: unknown;
    getThreePids?: ReturnType<typeof vi.fn>;
    requestAdd3pidEmailToken?: ReturnType<typeof vi.fn>;
    addThreePidOnly?: ReturnType<typeof vi.fn>;
    deleteThreePid?: ReturnType<typeof vi.fn>;
    client?: boolean;
  } = {},
) {
  const client = {
    getThreePids:
      options.getThreePids ??
      vi.fn().mockResolvedValue({ threepids: options.threepids ?? [] }),
    getCapabilities: vi.fn().mockResolvedValue(options.capabilities ?? {}),
    generateClientSecret: vi.fn(() => 'secret-1'),
    requestAdd3pidEmailToken:
      options.requestAdd3pidEmailToken ??
      vi.fn().mockResolvedValue({ sid: 'sid-1' }),
    addThreePidOnly: options.addThreePidOnly ?? vi.fn().mockResolvedValue({}),
    deleteThreePid: options.deleteThreePid ?? vi.fn().mockResolvedValue({}),
    getFallbackAuthUrl: vi.fn(
      (stage: string, session: string) => `https://hs/fb/${stage}/${session}`,
    ),
  };
  const clientFor = vi.fn((_accountId: string) =>
    options.client === false ? null : (client as never),
  );
  TestBed.configureTestingModule({
    providers: [
      EmailAddressesWorkflow,
      MockProvider(MatrixClientService, { clientFor }),
    ],
  });
  return Object.assign(TestBed.inject(EmailAddressesWorkflow), {
    client,
    clientFor,
  });
}

describe('EmailAddressesWorkflow.load', () => {
  it('returns email and msisdn addresses and drops other media', async () => {
    const workflow = setup({
      threepids: [
        { medium: 'email', address: 'a@b.c', added_at: 1 },
        { medium: 'msisdn', address: '4412' },
        { medium: 'x.other', address: 'z' },
      ],
    });
    const result = await firstValueFrom(workflow.load(ALICE));
    expect(result).toEqual({
      kind: 'loaded',
      addresses: [
        { medium: 'email', address: 'a@b.c' },
        { medium: 'msisdn', address: '4412' },
      ],
      canChange: true,
    });
  });

  it('reads canChange from m.3pid_changes', async () => {
    const workflow = setup({
      capabilities: { 'm.3pid_changes': { enabled: false } },
    });
    expect(await firstValueFrom(workflow.load(ALICE))).toMatchObject({
      canChange: false,
    });
  });

  it('treats a missing m.3pid_changes as changeable', async () => {
    const workflow = setup({ capabilities: {} });
    expect(await firstValueFrom(workflow.load(ALICE))).toMatchObject({
      canChange: true,
    });
  });

  it('refuses with account-unavailable when the account has no client', async () => {
    const workflow = setup({ client: false });
    expect(await firstValueFrom(workflow.load(ALICE))).toEqual({
      kind: 'refused',
      reason: 'account-unavailable',
    });
  });

  it('maps a network failure to unreachable', async () => {
    const workflow = setup({
      getThreePids: vi.fn().mockRejectedValue(new ConnectionError('x')),
    });
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
    const result = await firstValueFrom(workflow.sendLink(ALICE, '  A@b.c '));
    expect(workflow.client.requestAdd3pidEmailToken).toHaveBeenCalledWith(
      'A@b.c',
      'secret-1',
      1,
    );
    expect(result).toEqual({ kind: 'sent', pending });
  });

  it('resend keeps the secret and bumps the attempt', async () => {
    const requestAdd3pidEmailToken = vi
      .fn()
      .mockResolvedValue({ sid: 'sid-2' });
    const workflow = setup({ requestAdd3pidEmailToken });
    const result = await firstValueFrom(workflow.resend(pending));
    expect(requestAdd3pidEmailToken).toHaveBeenCalledWith(
      'A@b.c',
      'secret-1',
      2,
    );
    expect(result).toEqual({
      kind: 'sent',
      pending: { ...pending, sid: 'sid-2', sendAttempt: 2 },
    });
  });

  it('refuses with account-unavailable when the account has no client', async () => {
    const workflow = setup({ client: false });
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
    const workflow = setup({
      requestAdd3pidEmailToken: vi
        .fn()
        .mockRejectedValue(new MatrixError({ errcode }, 400)),
    });
    expect(await firstValueFrom(workflow.sendLink(ALICE, 'a@b.c'))).toEqual({
      kind: 'refused',
      reason,
    });
  });

  it('sendLink passes retryAfterMs on M_LIMIT_EXCEEDED', async () => {
    const workflow = setup({
      requestAdd3pidEmailToken: vi
        .fn()
        .mockRejectedValue(
          new MatrixError(
            { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 3000 },
            429,
          ),
        ),
    });
    expect(await firstValueFrom(workflow.sendLink(ALICE, 'a@b.c'))).toEqual({
      kind: 'refused',
      reason: 'rate-limited',
      retryAfterMs: 3000,
    });
  });

  it('omits retryAfterMs when the rate limit carries none', async () => {
    const workflow = setup({
      requestAdd3pidEmailToken: vi
        .fn()
        .mockRejectedValue(
          new MatrixError({ errcode: 'M_LIMIT_EXCEEDED' }, 429),
        ),
    });
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
  const uia = (stages: string[]) =>
    new MatrixError({ session: 's', flows: [{ stages }] }, 401);
  const stages = (password: string | null = 'pw') => ({
    password: vi.fn().mockResolvedValue(password),
    confirmInBrowser: vi.fn().mockResolvedValue(true),
  });

  it('adds with the pending session and no auth on the probe', async () => {
    const workflow = setup();
    const result = await firstValueFrom(workflow.add(pending, stages()));
    expect(result).toEqual({ kind: 'added' });
    expect(workflow.client.addThreePidOnly).toHaveBeenCalledTimes(1);
    const body = workflow.client.addThreePidOnly.mock.calls[0][0];
    expect(body).toMatchObject({ sid: 'sid-1', client_secret: 'secret-1' });
    expect(body.auth).toBeUndefined();
  });

  it('uses the pending account, not the active one', async () => {
    const workflow = setup();
    await firstValueFrom(
      workflow.add({ ...pending, accountId: '@bob:example.org' }, stages()),
    );
    expect(workflow.clientFor).toHaveBeenCalledWith('@bob:example.org');
  });

  it('answers a password stage', async () => {
    const addThreePidOnly = vi
      .fn()
      .mockRejectedValueOnce(uia(['m.login.password']))
      .mockResolvedValueOnce({});
    const workflow = setup({ addThreePidOnly });
    const result = await firstValueFrom(workflow.add(pending, stages()));
    expect(result).toEqual({ kind: 'added' });
    expect(addThreePidOnly.mock.calls[1][0].auth).toEqual({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: ALICE },
      password: 'pw',
      session: 's',
    });
  });

  it('maps M_THREEPID_AUTH_FAILED to not-verified', async () => {
    const workflow = setup({
      addThreePidOnly: vi
        .fn()
        .mockRejectedValue(
          new MatrixError({ errcode: 'M_THREEPID_AUTH_FAILED' }, 400),
        ),
    });
    expect(await firstValueFrom(workflow.add(pending, stages()))).toEqual({
      kind: 'refused',
      reason: 'not-verified',
    });
  });

  it('maps a cancelled prompt to cancelled', async () => {
    const workflow = setup({
      addThreePidOnly: vi.fn().mockRejectedValue(uia(['m.login.password'])),
    });
    expect(await firstValueFrom(workflow.add(pending, stages(null)))).toEqual({
      kind: 'refused',
      reason: 'cancelled',
    });
  });

  it('opens the fallback page for a non-password stage', async () => {
    const addThreePidOnly = vi
      .fn()
      .mockRejectedValueOnce(uia(['m.login.sso']))
      .mockResolvedValueOnce({});
    const workflow = setup({ addThreePidOnly });
    const s = stages();
    const result = await firstValueFrom(workflow.add(pending, s));
    expect(result).toEqual({ kind: 'added' });
    expect(s.confirmInBrowser).toHaveBeenCalledWith({
      url: workflow.client.getFallbackAuthUrl('m.login.sso', 's'),
      pending: false,
    });
  });

  it('flags the fallback step pending when the server repeats the stage', async () => {
    const addThreePidOnly = vi
      .fn()
      .mockRejectedValueOnce(uia(['m.login.sso']))
      .mockRejectedValueOnce(uia(['m.login.sso']))
      .mockResolvedValueOnce({});
    const workflow = setup({ addThreePidOnly });
    const s = stages();
    await firstValueFrom(workflow.add(pending, s));
    expect(s.confirmInBrowser.mock.calls.map(([step]) => step.pending)).toEqual(
      [false, true],
    );
  });

  it('maps a challenge with no stage left to no-usable-stage', async () => {
    const workflow = setup({
      addThreePidOnly: vi
        .fn()
        .mockRejectedValue(
          new MatrixError({ session: 's', flows: [{ stages: [] }] }, 401),
        ),
    });
    expect(await firstValueFrom(workflow.add(pending, stages()))).toEqual({
      kind: 'refused',
      reason: 'no-usable-stage',
    });
  });

  it('maps repeated rejected passwords to attempts-exceeded', async () => {
    const workflow = setup({
      addThreePidOnly: vi.fn().mockRejectedValue(uia(['m.login.password'])),
    });
    expect(await firstValueFrom(workflow.add(pending, stages()))).toEqual({
      kind: 'refused',
      reason: 'attempts-exceeded',
    });
  });

  it('refuses with account-unavailable when the account has no client', async () => {
    const workflow = setup({ client: false });
    expect(await firstValueFrom(workflow.add(pending, stages()))).toEqual({
      kind: 'refused',
      reason: 'account-unavailable',
    });
  });
});

describe('EmailAddressesWorkflow.remove', () => {
  const address = { medium: 'email', address: 'a@b.c' } as const;

  it('deletes by medium and address', async () => {
    const workflow = setup();
    expect(await firstValueFrom(workflow.remove(ALICE, address))).toEqual({
      kind: 'removed',
    });
    expect(workflow.client.deleteThreePid).toHaveBeenCalledWith(
      'email',
      'a@b.c',
    );
  });

  it('maps a failure to failed', async () => {
    const workflow = setup({
      deleteThreePid: vi
        .fn()
        .mockRejectedValue(new MatrixError({ errcode: 'M_UNKNOWN' }, 500)),
    });
    expect(await firstValueFrom(workflow.remove(ALICE, address))).toEqual({
      kind: 'refused',
      reason: 'failed',
    });
  });

  it('resolves the client at subscribe time', async () => {
    const workflow = setup();
    const result$ = workflow.remove(ALICE, address);
    expect(workflow.clientFor).not.toHaveBeenCalled();
    await firstValueFrom(result$);
    expect(workflow.clientFor).toHaveBeenCalledWith(ALICE);
  });
});
