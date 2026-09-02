import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { TrnDialogService } from '@trinity/components/overlay';
import { ReactionPickerComponent } from './reaction-picker.component';
import { ReactionPickerService } from './reaction-picker.service';
import { firstValueFrom, of, toArray } from 'rxjs';

describe('ReactionPickerService', () => {
  function setup(result: string | null) {
    const openAndWait$ = vi.fn(() => of(result));
    TestBed.configureTestingModule({
      providers: [
        ReactionPickerService,
        { provide: TrnDialogService, useValue: { openAndWait$ } },
      ],
    });
    return { svc: TestBed.inject(ReactionPickerService), openAndWait$ };
  }

  it('opens the reaction picker dialog and emits the chosen emoji', async () => {
    const { svc, openAndWait$ } = setup('🎯');
    const command$ = svc.pick$();
    expect(openAndWait$).not.toHaveBeenCalled();
    const chosen = await firstValueFrom(command$);
    // The ariaLabel is the assertion, not incidental: the CDK container is the element
    // that actually carries `role="dialog"` here, and it had no accessible name at all
    // until #152 — a screen reader announced this as just "dialog".
    expect(openAndWait$).toHaveBeenCalledWith(ReactionPickerComponent, {
      ariaLabel: 'Pick a reaction',
    });
    expect(chosen).toBe('🎯');
  });

  it('completes without a value when the dialog is dismissed', async () => {
    const { svc } = setup(null);
    expect(await firstValueFrom(svc.pick$().pipe(toArray()))).toEqual([]);
  });
});
