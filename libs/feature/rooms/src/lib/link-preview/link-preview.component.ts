import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { Subscription } from 'rxjs';
import {
  UrlPreviewService,
  type UrlPreview,
} from '@trinity/data-access/timeline';
import { PrivacySettingsService } from '@trinity/platform-native';
import { AVATAR_RESOLVER } from '@trinity/components/generic-content';

/** Thumbnail edge (px) requested from the avatar/media resolver for the preview image. */
const IMAGE_SIZE = 320;

/**
 * A link-preview card under a message: title, host, description, and thumbnail from the
 * homeserver's Open-Graph proxy. Renders nothing until (and unless) a preview resolves,
 * and only fetches when the user's link-preview preference is on. Fetching a preview
 * discloses the URL to the homeserver, so for a message from an encrypted room
 * (`encrypted`) it additionally requires the explicit "previews in encrypted rooms" opt-in.
 */
@Component({
  selector: 'trn-link-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './link-preview.component.html',
  styleUrl: './link-preview.component.scss',
})
export class LinkPreviewComponent {
  readonly url = input.required<string>();
  /** Whether the message is from an encrypted room (needs the encrypted-rooms opt-in). */
  readonly encrypted = input(false);
  /** The message's room; without the opt-in it must be confirmed unencrypted first. */
  readonly roomId = input<string | null>(null);

  private readonly previews = inject(UrlPreviewService);
  private readonly privacy = inject(PrivacySettingsService);
  private readonly resolver = inject(AVATAR_RESOLVER, { optional: true });

  readonly preview = signal<UrlPreview | null>(null);
  readonly imageUrl = signal<string | null>(null);

  readonly host = computed(() => {
    try {
      return new URL(this.url()).host;
    } catch {
      return null;
    }
  });

  constructor() {
    // Fetch when the URL (or a preference) changes; clear + skip when previews are off.
    // In an encrypted room the fetch also needs the explicit encrypted-rooms opt-in,
    // since it would send the message's URL to the homeserver. Without it the room is
    // checked against the crypto store too, as its state can lack the encryption event.
    effect((onCleanup) => {
      const url = this.url();
      const allowEncrypted = this.privacy.linkPreviewsInEncrypted();
      const roomId = this.roomId();
      const enabled =
        this.privacy.linkPreviews() && (!this.encrypted() || allowEncrypted);
      this.preview.set(null);
      this.imageUrl.set(null);
      if (!enabled) {
        return;
      }
      const subs = new Subscription();
      subs.add(
        (allowEncrypted
          ? this.previews.preview(url)
          : this.previews.previewIfUnencrypted(url, roomId)
        ).subscribe((preview) => {
          this.preview.set(preview);
          if (preview?.imageMxc && this.resolver) {
            subs.add(
              this.resolver(preview.imageMxc, IMAGE_SIZE).subscribe(
                (resolved) => this.imageUrl.set(resolved),
              ),
            );
          }
        }),
      );
      onCleanup(() => subs.unsubscribe());
    });
  }
}
