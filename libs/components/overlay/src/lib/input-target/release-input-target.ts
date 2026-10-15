import { DestroyRef, ElementRef, inject } from '@angular/core';
import { InputModalityDetector } from '@angular/cdk/a11y';

/**
 * When the calling component is destroyed, stop the CDK's input-modality detector from keeping
 * an element inside it alive. Call it in the component's injection context.
 *
 * The detector (a root service behind tooltips, menus and focus monitoring) records the target
 * of the last mousedown, touchstart or keydown, and nothing clears it until the next one. A
 * panel closed by a press or key inside it would stay in memory, detached, until then (#1361).
 * The CDK has no public way to clear it, so this writes its internal `_mostRecentTarget` back
 * to its initial `null`; `release-input-target.spec.ts` fails if that field changes. `null` is
 * what the detector reads as "no recent target", and a detached element could not match a
 * later focus target anyway.
 */
export function releaseInputTargetOnDestroy(): void {
  const host = inject<ElementRef<Element>>(ElementRef).nativeElement;
  const detector = inject(InputModalityDetector);
  inject(DestroyRef).onDestroy(() => {
    const target = detector._mostRecentTarget;
    if (target && host.contains(target)) {
      detector._mostRecentTarget = null;
    }
  });
}
