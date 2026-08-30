import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  AfterViewInit,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { TrnDialogRef } from '@trinity/components/overlay';
import {
  WidgetBridgeService,
  type RoomWidget,
  type WidgetBridgeSession,
  type WidgetEmbed,
} from '@trinity/data-access/widgets';
import { TrnButton } from '@trinity/components/controls';

@Component({
  selector: 'trn-room-widget-frame',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton],
  templateUrl: './room-widget-frame.component.html',
  styleUrl: './room-widget-frame.component.scss',
})
export class RoomWidgetFrameComponent implements AfterViewInit, OnDestroy {
  readonly roomId = input.required<string>();
  readonly widget = input.required<RoomWidget>();
  readonly embed = input.required<WidgetEmbed>();

  private readonly bridge = inject(WidgetBridgeService);
  private readonly dialogRef = inject<TrnDialogRef<void>>(TrnDialogRef);
  private readonly frame =
    viewChild.required<ElementRef<HTMLIFrameElement>>('widgetFrame');
  private readonly session = signal<WidgetBridgeSession | null>(null);
  private readonly startupFailed = signal(false);

  readonly state = computed(() =>
    this.startupFailed()
      ? 'startup-failed'
      : (this.session()?.state() ?? 'frame-loading'),
  );

  readonly statusText = computed(() => {
    switch (this.state()) {
      case 'startup-failed':
        return 'Trinity could not start this widget. No third-party page was loaded.';
      case 'ready':
        return 'Widget API ready. No Matrix capabilities were granted.';
      case 'failed':
        return 'The widget loaded, but its Widget API connection failed.';
      case 'negotiating':
        return 'Negotiating the restricted Widget API connection…';
      default:
        return 'Loading the third-party widget…';
    }
  });

  ngAfterViewInit(): void {
    const iframe = this.frame().nativeElement;
    const embed = this.embed();
    if (!embed.url) {
      this.startupFailed.set(true);
      return;
    }
    try {
      this.session.set(
        this.bridge.start(this.widget(), embed, this.roomId(), iframe),
      );
      iframe.setAttribute('src', embed.url);
    } catch {
      this.startupFailed.set(true);
    }
  }

  ngOnDestroy(): void {
    this.session()?.stop();
  }

  close(): void {
    this.session()?.stop();
    this.dialogRef.close();
  }
}
