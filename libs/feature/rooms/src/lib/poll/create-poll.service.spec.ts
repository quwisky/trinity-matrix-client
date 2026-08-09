import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { type Observable, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TrnDialogService, TrnToastService } from '@trinity/helm/overlay';
import { TimelineActionsService } from '@trinity/data-access/timeline';
import { CreatePollService } from './create-poll.service';
import { type NewPoll } from './create-poll-dialog.component';

function setup(
  result: NewPoll | null,
  createResult: Observable<void> = of(undefined),
) {
  const openAndWait = vi.fn().mockResolvedValue(result);
  const createPoll = vi.fn(() => createResult);
  const show = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      CreatePollService,
      MockProvider(TrnDialogService, { openAndWait }),
      MockProvider(TimelineActionsService, { createPoll }),
      MockProvider(TrnToastService, { show }),
    ],
  });
  return { svc: TestBed.inject(CreatePollService), createPoll, show };
}

describe('CreatePollService', () => {
  it('creates the poll returned by the dialog', async () => {
    const { svc, createPoll } = setup({
      question: 'Best fruit?',
      options: ['Apple', 'Pear'],
    });
    await svc.open();
    expect(createPoll).toHaveBeenCalledWith('Best fruit?', ['Apple', 'Pear']);
  });

  it('does nothing when the dialog is cancelled', async () => {
    const { svc, createPoll } = setup(null);
    await svc.open();
    expect(createPoll).not.toHaveBeenCalled();
  });

  it('toasts when creating the poll fails', async () => {
    const { svc, show } = setup(
      { question: 'Q', options: ['A', 'B'] },
      throwError(() => new Error('boom')),
    );
    await svc.open();
    expect(show).toHaveBeenCalledWith(
      'Could not create the poll.',
      expect.objectContaining({ variant: 'destructive' }),
    );
  });
});
