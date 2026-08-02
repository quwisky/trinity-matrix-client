import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { catchError, of, switchMap } from 'rxjs';
import { GifService } from '@trinity/data-access/gif';

/**
 * A single GIF preview. The app's CSP forbids binding a remote `<img src>`
 * (tracking-pixel guard), so — like avatars and media — the bytes are fetched
 * over `connect-src` and bound as a `blob:` object URL, revoked when the source
 * URL changes or the thumb is destroyed.
 */
@Component({
  selector: 'trn-gif-thumb',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (objectUrl(); as src) {
      <img class="gif-thumb__img" [src]="src" [alt]="alt()" />
    }
  `,
  styleUrl: './gif-thumb.component.scss',
})
export class GifThumbComponent {
  readonly url = input.required<string>();
  readonly alt = input('');
  readonly objectUrl = signal<string | null>(null);

  private readonly gifs = inject(GifService);

  constructor() {
    const destroyRef = inject(DestroyRef);
    let current: string | null = null;
    const revoke = (): void => {
      if (current) {
        URL.revokeObjectURL(current);
        current = null;
      }
    };
    // switchMap cancels an in-flight fetch if the URL changes; catchError keeps a
    // failed preview from tearing down the stream (the thumb just stays blank).
    toObservable(this.url)
      .pipe(
        switchMap((u) =>
          this.gifs.fetchPreview(u).pipe(catchError(() => of(null))),
        ),
        takeUntilDestroyed(destroyRef),
      )
      .subscribe((obj) => {
        if (!obj) {
          return;
        }
        revoke();
        current = obj;
        this.objectUrl.set(obj);
      });
    destroyRef.onDestroy(revoke);
  }
}
