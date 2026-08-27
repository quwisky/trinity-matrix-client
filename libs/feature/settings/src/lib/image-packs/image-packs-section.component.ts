import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {
  FormField,
  FormRoot,
  form,
  submit,
  validate,
} from '@angular/forms/signals';
import { ActivatedRoute } from '@angular/router';
import { TrnInput } from '@trinity/components/input';
import { TrnCheckboxComponent } from '@trinity/components/checkbox';
import { TrnLabel } from '@trinity/components/label';
import { TrnAlertService } from '@trinity/components/overlay';
import {
  ImagePackManagementError,
  ImagePackManagementService,
  type ImagePackDiscovery,
  type ManagedImagePack,
  type ImagePackUsage,
  validateImagePackSource,
} from '@trinity/data-access/media';
import { HlmButton } from '@trinity/helm/button';
import { firstValueFrom } from 'rxjs';

interface SourceFormModel {
  source: string;
}

@Component({
  selector: 'trn-image-packs-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormField,
    FormRoot,
    HlmButton,
    TrnCheckboxComponent,
    TrnInput,
    TrnLabel,
  ],
  templateUrl: './image-packs-section.component.html',
  styleUrl: './image-packs-section.component.scss',
})
export class ImagePacksSectionComponent {
  private readonly management = inject(ImagePackManagementService);
  private readonly alert = inject(TrnAlertService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly sourceModel = signal<SourceFormModel>({ source: '' });
  private readonly resultsHeading =
    viewChild<ElementRef<HTMLElement>>('resultsHeading');
  private readonly installedHeading =
    viewChild<ElementRef<HTMLElement>>('installedHeading');

  readonly installed = this.management.installed;
  readonly discovery = signal<ImagePackDiscovery | null>(null);
  readonly finding = signal(false);
  readonly busyId = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly installedIds = computed(
    () => new Set(this.installed().map((pack) => pack.id)),
  );

  readonly sourceForm = form(this.sourceModel, (path) => {
    validate(path.source, ({ value }) => {
      try {
        validateImagePackSource(value());
        return undefined;
      } catch {
        return {
          kind: 'invalid-source',
          message:
            'Enter a Matrix room ID or alias, such as #stickers:example.org.',
        };
      }
    });
  });

  constructor() {
    this.management.connect();
    this.destroyRef.onDestroy(() => this.management.disconnect());
    const roomId = this.route.snapshot.queryParamMap.get('roomId');
    if (roomId) {
      this.sourceForm.source().value.set(roomId);
    }
  }

  async find(): Promise<void> {
    this.error.set(null);
    this.notice.set(null);
    await submit(this.sourceForm, {
      action: async (field) => {
        this.discovery.set(null);
        this.finding.set(true);
        try {
          const result = await firstValueFrom(
            this.management.discover(field().value().source),
          );
          this.discovery.set(result);
          queueMicrotask(() => this.resultsHeading()?.nativeElement.focus());
        } catch (error) {
          this.discovery.set(null);
          this.error.set(managementErrorText(error, 'discover'));
        } finally {
          this.finding.set(false);
        }
        return undefined;
      },
    });
  }

  async install(pack: ManagedImagePack): Promise<void> {
    this.error.set(null);
    this.notice.set(null);
    this.busyId.set(pack.id);
    try {
      await firstValueFrom(this.management.install(pack));
      this.notice.set(`${pack.name} is now available in all rooms.`);
    } catch (error) {
      this.error.set(managementErrorText(error, 'install'));
    } finally {
      this.busyId.set(null);
    }
  }

  async remove(pack: ManagedImagePack): Promise<void> {
    this.error.set(null);
    this.notice.set(null);
    const confirmed = await this.alert.confirm({
      header: `Remove ${pack.name}?`,
      message:
        'This removes the pack from your account only. You will stay in the source room, and its state and media will not be deleted.',
      confirmText: 'Remove pack',
      destructive: true,
    });
    if (!confirmed) return;
    this.busyId.set(pack.id);
    try {
      await firstValueFrom(this.management.uninstall(pack));
      this.notice.set(`${pack.name} was removed from your account.`);
      queueMicrotask(() => this.installedHeading()?.nativeElement.focus());
    } catch (error) {
      this.error.set(managementErrorText(error, 'remove'));
    } finally {
      this.busyId.set(null);
    }
  }

  async setUsage(
    pack: ManagedImagePack,
    usage: ImagePackUsage,
    enabled: boolean,
  ): Promise<void> {
    this.error.set(null);
    this.notice.set(null);
    this.busyId.set(pack.id);
    const next = pack.enabledUsage.filter((item) => item !== usage);
    if (enabled) next.push(usage);
    const canonical = (['emoticon', 'sticker'] as const).filter((item) =>
      next.includes(item),
    );
    try {
      await firstValueFrom(this.management.setEnabledUsage(pack, canonical));
      this.notice.set(`${pack.name} usage was updated.`);
    } catch (error) {
      this.error.set(managementErrorText(error, 'usage'));
    } finally {
      this.busyId.set(null);
    }
  }

  statusText(pack: ManagedImagePack): string {
    switch (pack.status) {
      case 'available':
        return `${pack.imageCount} image${pack.imageCount === 1 ? '' : 's'}`;
      case 'empty':
        return 'This pack has no images.';
      case 'unavailable':
        return 'The source room is not available on this device.';
      case 'missing':
        return 'The pack state was deleted or is missing.';
      case 'malformed':
        return 'The pack data is malformed and cannot be used.';
    }
  }
}

function managementErrorText(
  error: unknown,
  action: 'discover' | 'install' | 'remove' | 'usage',
): string {
  if (error instanceof ImagePackManagementError) {
    switch (error.code) {
      case 'invalid-source':
        return 'Enter a valid Matrix room ID or alias.';
      case 'not-signed-in':
        return 'Sign in before managing image packs.';
      case 'no-packs':
        return 'That room has no usable image packs.';
      case 'write-conflict':
        return 'Another device changed your packs at the same time. Try again.';
    }
  }
  if (action === 'discover') {
    return 'Could not join or read that room. Check the address and your access.';
  }
  if (action === 'install') return 'Could not install the pack. Try again.';
  if (action === 'usage') return 'Could not update the pack. Try again.';
  return 'Could not remove the pack. Try again.';
}
