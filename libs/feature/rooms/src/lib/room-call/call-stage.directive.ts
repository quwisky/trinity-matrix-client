import {
  DestroyRef,
  Directive,
  ElementRef,
  afterNextRender,
  inject,
} from '@angular/core';
import { CallStageService } from '@trinity/data-access/calls';

/** Offers its element as the area the app-level call host draws the active call over. */
@Directive({ selector: '[trnCallStage]' })
export class CallStageDirective {
  constructor() {
    const stage = inject(CallStageService);
    const element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => destroyRef.onDestroy(stage.register(element)));
  }
}
