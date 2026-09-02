import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnButton } from '@trinity/components/controls';
import {
  TrnDialogService,
  type TrnDialogPlacement,
} from '../../../dialog/trn-dialog.service';
import type { TrnOverlaySurfaceLayout } from '../../trn-overlay-surface-recipe';
import { OverlayStoryDialogComponent } from '../overlay-story-dialog/overlay-story-dialog.component';

@Component({
  selector: 'trn-dialog-overlay-story',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton],
  templateUrl: './dialog-overlay-story.component.html',
})
export class DialogOverlayStoryComponent {
  private readonly dialog = inject(TrnDialogService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly result = signal('No dialog result');

  protected openCanonical(
    placement: TrnDialogPlacement,
    layout: TrnOverlaySurfaceLayout,
    anchor?: HTMLElement,
  ): void {
    this.dialog
      .openAndWait$<string, OverlayStoryDialogComponent>(
        OverlayStoryDialogComponent,
        {
          placement,
          ...(anchor ? { anchor } : {}),
          ariaLabel: `Canonical ${placement} dialog`,
          inputs: { title: `Canonical ${placement}`, layout },
        },
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((value) => this.result.set(value ?? 'Dismissed'));
  }
}
