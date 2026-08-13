import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import { TrnDialogService } from '@trinity/helm/overlay';
import { ReactionPickerComponent } from './reaction-picker.component';
import { ReactionPickerService } from './reaction-picker.service';

describe('ReactionPickerService', () => {
  function setup(result: string | null) {
    const openAndWait = vi.fn().mockResolvedValue(result);
    TestBed.configureTestingModule({
      providers: [
        ReactionPickerService,
        MockProvider(TrnDialogService, { openAndWait }),
      ],
    });
    return { svc: TestBed.inject(ReactionPickerService), openAndWait };
  }

  it('opens the reaction picker dialog and resolves the chosen emoji', async () => {
    const { svc, openAndWait } = setup('🎯');
    const chosen = await svc.pick();
    // The ariaLabel is the assertion, not incidental: the CDK container is the element
    // that actually carries `role="dialog"` here, and it had no accessible name at all
    // until #152 — a screen reader announced this as just "dialog".
    expect(openAndWait).toHaveBeenCalledWith(ReactionPickerComponent, {
      ariaLabel: 'Pick a reaction',
    });
    expect(chosen).toBe('🎯');
  });

  it('resolves null when the dialog is dismissed', async () => {
    const { svc } = setup(null);
    expect(await svc.pick()).toBeNull();
  });
});
