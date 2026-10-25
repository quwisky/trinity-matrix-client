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
  };
  TestBed.configureTestingModule({
    providers: [
      EmailAddressesWorkflow,
      MockProvider(MatrixClientService, {
        clientFor: vi.fn(() =>
          options.client === false ? null : (client as never),
        ),
      }),
    ],
  });
  return Object.assign(TestBed.inject(EmailAddressesWorkflow), { client });
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
