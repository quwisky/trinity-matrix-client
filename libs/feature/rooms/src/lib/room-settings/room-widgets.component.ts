import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  TrnAlertService,
  TrnDialogRef,
  TrnDialogService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  WidgetManagementError,
  WidgetManagementService,
  WidgetsService,
  isCallWidgetType,
  resolveWidgetEmbed,
  type RoomWidget,
  type WidgetEmbed,
  type WidgetLaunch,
} from '@trinity/data-access/widgets';
import { HlmButton } from '@trinity/helm/button';
import { ExternalBrowserService } from '@trinity/platform-native';
import { RoomWidgetFrameComponent } from './room-widget-frame/room-widget-frame.component';
import { RoomWidgetCreateComponent } from './room-widget-create/room-widget-create.component';

interface WidgetEntry {
  readonly widget: RoomWidget;
  readonly launch: WidgetLaunch;
  readonly embed: WidgetEmbed;
}

/** Room-widget discovery, safe launch surfaces, and power-gated management. */
@Component({
  selector: 'trn-room-widgets',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButton, RoomWidgetCreateComponent],
  templateUrl: './room-widgets.component.html',
  styleUrl: './room-widgets.component.scss',
})
export class RoomWidgetsComponent implements OnInit {
  readonly roomId = input.required<string>();

  private readonly widgetsService = inject(WidgetsService);
  private readonly management = inject(WidgetManagementService);
  private readonly externalBrowser = inject(ExternalBrowserService);
  private readonly toast = inject(TrnToastService);
  private readonly alert = inject(TrnAlertService);
  private readonly dialog = inject(TrnDialogService);
  private readonly destroyRef = inject(DestroyRef);
  private connectedRoom: string | null = null;
  private activeWidgetFrame: TrnDialogRef<void> | null = null;
  private readonly createWidget = viewChild(RoomWidgetCreateComponent);
  private readonly focusAfterRemoval = new Set<string>();
  private readonly removalRevisions = new Map<string, string>();
  readonly removing = signal<ReadonlySet<string>>(new Set());

  readonly canManage = computed(() =>
    this.widgetsService.canManageFor(this.roomId())(),
  );

  /** Widgets plus their current, disclosure-audited external destinations. */
  readonly widgets = computed<readonly WidgetEntry[]>(() =>
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
      this.activeWidgetFrame?.close();
      this.activeWidgetFrame = null;
      if (this.connectedRoom) {
        this.widgetsService.disconnect(this.connectedRoom);
      }
    });
    effect(() => {
      const visible = new Map(
        this.widgets().map((entry) => [entry.widget.id, entry] as const),
      );
      for (const id of [...this.focusAfterRemoval]) {
        this.reconcileRemoval(id, visible);
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
    this.activeWidgetFrame?.close();
    const frameRef = this.dialog.open<void, RoomWidgetFrameComponent>(
      RoomWidgetFrameComponent,
      {
        side: 'full-screen',
        ariaLabel: `${widget.name} widget`,
        autoFocus: '[data-autofocus]',
        inputs: {
          roomId: this.roomId(),
          widget,
          embed,
        },
      },
    );
    this.activeWidgetFrame = frameRef;
    frameRef.closed.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (this.activeWidgetFrame === frameRef) {
        this.activeWidgetFrame = null;
      }
    });
  }

  canRemove(widget: RoomWidget): boolean {
    return (
      this.canManage() &&
      !!widget.sourceEventId &&
      !isCallWidgetType(widget.type)
    );
  }

  isRemoving(widgetId: string): boolean {
    return this.removing().has(widgetId);
  }

  /** Confirm the named cross-client impact, then tombstone only that projected revision. */
  async removeWidget(widget: RoomWidget, origin: string | null): Promise<void> {
    if (!this.canRemove(widget) || this.isRemoving(widget.id)) {
      return;
    }
    this.removing.update((pending) => new Set(pending).add(widget.id));
    this.removalRevisions.set(widget.id, widget.sourceEventId as string);
    const confirmed = await this.alert.confirm({
      header: 'Remove widget',
      message:
        `Remove “${widget.name}”${origin ? ` (${origin})` : ''} from this room? ` +
        'It will disappear for every member and Matrix client.',
      confirmText: 'Remove',
      destructive: true,
    });
    if (!confirmed) {
      this.clearRemoving(widget.id);
      return;
    }

    this.management
      .remove(this.roomId(), widget)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.focusAfterRemoval.add(widget.id);
          this.reconcileRemoval(
            widget.id,
            new Map(
              untracked(this.widgets).map((entry) => [entry.widget.id, entry]),
            ),
          );
        },
        error: (error: unknown) => {
          this.clearRemoving(widget.id);
          this.toast.show(removalFailureText(error), {
            duration: 4000,
            variant: 'destructive',
          });
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

  private clearRemoving(widgetId: string): void {
    this.focusAfterRemoval.delete(widgetId);
    this.removalRevisions.delete(widgetId);
    this.removing.update((pending) => {
      const next = new Set(pending);
      next.delete(widgetId);
      return next;
    });
  }

  private reconcileRemoval(
    widgetId: string,
    visible: ReadonlyMap<string, WidgetEntry>,
  ): void {
    const current = visible.get(widgetId);
    if (!current) {
      this.clearRemoving(widgetId);
      this.toast.show('Widget removed.', {
        duration: 3000,
        variant: 'success',
      });
      this.createWidget()?.focusName();
      return;
    }
    if (current.widget.sourceEventId !== this.removalRevisions.get(widgetId)) {
      this.clearRemoving(widgetId);
      this.toast.show(
        'The widget was replaced while removal was in progress. Review it before trying again.',
        { duration: 4000, variant: 'destructive' },
      );
    }
  }
}

function currentOrigin(): string {
  return typeof location === 'undefined' ? '' : location.origin;
}

function removalFailureText(error: unknown): string {
  if (error instanceof WidgetManagementError) {
    switch (error.code) {
      case 'conflict':
        return 'This widget changed before it could be removed. Review it and try again.';
      case 'forbidden':
        return 'You no longer have permission to remove widgets.';
      case 'unsupported-type':
        return 'Call widgets cannot be removed here.';
      default:
        break;
    }
  }
  return 'Could not remove the widget. Try again.';
}
