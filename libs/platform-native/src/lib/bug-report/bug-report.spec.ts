import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of, throwError, type Observable } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILD_INFO } from '../build-info';
import {
  BUG_REPORT_ACCOUNT_SOURCE,
  BugReportFactsService,
  type BugReportAccount,
  type BugReportFacts,
} from './bug-report';

function readFacts(
  accounts?: () => Observable<readonly BugReportAccount[]>,
): Promise<BugReportFacts> {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: BUILD_INFO,
        useValue: { version: '1.2.3', commit: 'abc1234', builtAt: '' },
      },
      ...(accounts
        ? [{ provide: BUG_REPORT_ACCOUNT_SOURCE, useValue: { accounts } }]
        : []),
    ],
  });
  return firstValueFrom(TestBed.inject(BugReportFactsService).facts());
}

describe('BugReportFactsService', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('names the build, the platform and each homeserver’s software once', async () => {
    const synapse = { software: { name: 'Synapse', version: '1.140.0' } };

    expect(
      await readFacts(() => of([synapse, { software: null }, synapse])),
    ).toEqual({
      version: 'Trinity v1.2.3 · abc1234',
      platform: expect.any(String),
      homeservers: ['Synapse 1.140.0'],
    });
  });

  it('leaves the homeservers out without an account source', async () => {
    expect((await readFacts()).homeservers).toEqual([]);
  });

  it('leaves the homeservers out when the account source fails', async () => {
    const failing = () => throwError(() => new Error('registry unreadable'));

    expect((await readFacts(failing)).homeservers).toEqual([]);
  });
});
