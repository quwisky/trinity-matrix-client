import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  input,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnDialogService, TrnToastService } from '@trinity/components/overlay';
import {
  WidgetsService,
  resolveWidgetEmbed,
  type RoomWidget,
  type WidgetEmbed,
  type WidgetLaunch,
} from '@trinity/data-access/widgets';
import { HlmButton } from '@trinity/helm/button';
import { ExternalBrowserService } from '@trinity/platform-native';
import { RoomWidgetFrameComponent } from './room-widget-frame/room-widget-frame.component';

/** Tier 1 room-widget discovery and explicit external-browser dispatch. */
@Component({
  selector: 'trn-room-widgets',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButton],
  templateUrl: './room-widgets.component.html',
  styleUrl: './room-widgets.component.scss',
})
export class RoomWidgetsComponent implements OnInit {
  readonly roomId = input.required<string>();

  private readonly widgetsService = inject(WidgetsService);
  private readonly externalBrowser = inject(ExternalBrowserService);
  private readonly toast = inject(TrnToastService);
  private readonly dialog = inject(TrnDialogService);
  private readonly destroyRef = inject(DestroyRef);
  private connectedRoom: string | null = null;

  /** Widgets plus their current, disclosure-audited external destinations. */
  readonly widgets = computed(() =>
    this.widgetsService
      .widgetsFor(this.roomId())()
      .map((widget) => {
        const launch = this.widgetsService.launchFor(this.roomId(), widget);
        return {
          widget,
          launch,
          embed: resolveWidgetEmbed(widget, launch, currentOrigin()),
        };
      }),
  );

  constructor() {
    // The settings panel owns this demand-driven projection, so sessions that never open
    // room settings pay nothing for widget state they do not inspect.
    this.destroyRef.onDestroy(() => {
      if (this.connectedRoom) {
        this.widgetsService.disconnect(this.connectedRoom);
      }
    });
  }

  ngOnInit(): void {
    this.connectedRoom = this.roomId();
    this.widgetsService.connect(this.connectedRoom);
  }

  /** Keep link affordances while routing an intentional tap through platform browser UI. */
  openWidget(event: Event, url: string): void {
    event.preventDefault();
    this.externalBrowser
      .open(url)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((opened) => {
        if (!opened) {
          this.toast.show('Could not open this widget in a browser.', {
            duration: 4000,
            variant: 'destructive',
          });
        }
      });
  }

  /** Revalidate immediately before creating the only live third-party frame. */
  embedWidget(widget: RoomWidget): void {
    const launch = this.widgetsService.launchFor(this.roomId(), widget);
    const embed = resolveWidgetEmbed(widget, launch, currentOrigin());
    if (!embed.url) {
      this.toast.show('This widget cannot be embedded safely.', {
        duration: 4000,
        variant: 'destructive',
      });
      return;
    }
    this.dialog.open(RoomWidgetFrameComponent, {
      side: 'full-screen',
      ariaLabel: `${widget.name} widget`,
      autoFocus: '[data-autofocus]',
      inputs: {
        roomId: this.roomId(),
        widget,
        embed,
      },
    });
  }

  embedFailureText(embed: WidgetEmbed): string {
    switch (embed.failure) {
      case 'insecure':
        return 'Only HTTPS widgets can open inside Trinity.';
      case 'same-origin':
        return 'Same-origin widgets cannot open inside Trinity.';
      case 'missing-creator':
        return 'This declaration has no verified creator.';
      case 'call-widget':
        return 'Call widgets are not supported in this release.';
      default:
        return 'This widget cannot open inside Trinity.';
    }
  }

  disclosureText(launch: WidgetLaunch): string {
    return launch.disclosures.map((item) => item.label).join(', ');
  }
}

function currentOrigin(): string {
  return typeof location === 'undefined' ? '' : location.origin;
}
