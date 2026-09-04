import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceNavigationActivatorAdapter } from './workspace-navigation.activator';

afterEach(() => TestBed.resetTestingModule());

describe('WorkspaceNavigationActivatorAdapter', () => {
  it('mounts the Room shell without replacing the current browser location', async () => {
    const navigate = vi.fn().mockResolvedValue(true);
    TestBed.configureTestingModule({
      providers: [
        WorkspaceNavigationActivatorAdapter,
        { provide: Router, useValue: { navigate } },
        {
          provide: AccountRuntimeService,
          useValue: { activeAccountId: signal('@alice:example.org') },
        },
      ],
    });

    await expect(
      firstValueFrom(
        TestBed.inject(WorkspaceNavigationActivatorAdapter).activate(),
      ),
    ).resolves.toEqual({ kind: 'ready' });
    expect(navigate).toHaveBeenCalledWith(['/rooms'], {
      skipLocationChange: true,
      queryParams: { account: '@alice:example.org' },
    });
  });

  it('normalizes a rejected mount as typed unavailability', async () => {
    TestBed.configureTestingModule({
      providers: [
        WorkspaceNavigationActivatorAdapter,
        {
          provide: Router,
          useValue: { navigate: () => Promise.resolve(false) },
        },
        {
          provide: AccountRuntimeService,
          useValue: { activeAccountId: signal(null) },
        },
      ],
    });

    await expect(
      firstValueFrom(
        TestBed.inject(WorkspaceNavigationActivatorAdapter).activate(),
      ),
    ).resolves.toEqual({ kind: 'unavailable' });
  });
});
