import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ConnectionError } from '@trinity/util/matrix';
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
    client?: boolean;
  } = {},
) {
  const client = {
    getThreePids:
      options.getThreePids ??
      vi.fn().mockResolvedValue({ threepids: options.threepids ?? [] }),
    getCapabilities: vi.fn().mockResolvedValue(options.capabilities ?? {}),
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
  return TestBed.inject(EmailAddressesWorkflow);
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
    expect(result).toMatchObject({
      kind: 'loaded',
      addresses: [
        { medium: 'email', address: 'a@b.c' },
        { medium: 'msisdn', address: '4412' },
      ],
    });
    expect(result.kind === 'loaded' && result.addresses[0]).toEqual({
      medium: 'email',
      address: 'a@b.c',
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
