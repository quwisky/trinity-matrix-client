import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { TrnTooltip } from '@trinity/components/generic-content';
import { DateTimeFormatService } from '@trinity/platform-native';
import { hasUsableTimestamp } from '@trinity/util/matrix';

/**
 * A message's time, either in the gutter of a grouped row or in a header line.
 *
 * Its tooltip registers window listeners and a focus monitor, which is a lot to pay for every
 * row a scroll builds, so it exists only once the row says `armed` (a mouse or pen first
 * reached the row, or this time). The element is replaced as it is armed, so a pointer already
 * on it is handed the entry the new tooltip never saw. The host is `display: contents`: the
 * `<time>` is an item of the row's flex layout.
 */
@Component({
  selector: 'trn-message-time',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnTooltip],
  templateUrl: './message-time.component.html',
  styleUrl: './message-time.component.scss',
})
export class MessageTimeComponent {
  private readonly injector = inject(Injector);
  private readonly stamp = viewChild<ElementRef<HTMLElement>>('stamp');

  protected readonly fmt = inject(DateTimeFormatService);

  readonly timestamp = input.required<number>();
  /** Whether the tooltip exists yet; owned by the row, which arms every time on hover. */
  readonly armed = input.required<boolean>();
  readonly variant = input.required<'gutter' | 'head'>();
  /** A mouse or pen reached an unarmed time. */
  readonly arm = output<void>();

  protected readonly iso = computed(() =>
    hasUsableTimestamp(this.timestamp())
      ? new Date(this.timestamp()).toISOString()
      : null,
  );

  protected onPointerEnter(event: PointerEvent): void {
    const { pointerType } = event;
    if (pointerType !== 'mouse' && pointerType !== 'pen') {
      return;
    }
    this.arm.emit();
    afterNextRender(
      {
        read: () =>
          this.stamp()?.nativeElement.dispatchEvent(
            new PointerEvent('pointerenter', { pointerType }),
          ),
      },
      { injector: this.injector },
    );
  }
}
