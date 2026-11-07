import { DestroyRef } from '@angular/core';

/**
 * Opens an on-demand panel whose chunk loads first. One load at a time: a second request
 * while one is pending is dropped, since the dialog backdrop that used to stop a repeat
 * press only exists after the open. After the load it opens only if the owner is alive
 * and the context the request was made in is still current.
 */
export class LazyPanelOpener {
  private loading = false;
  private destroyed = false;

  constructor(
    destroyRef: DestroyRef,
    private readonly onLoadFailure: (message: string) => void,
  ) {
    destroyRef.onDestroy(() => (this.destroyed = true));
  }

  async open<M>(
    load: () => Promise<M>,
    failureMessage: string,
    isCurrent: () => boolean,
    show: (loaded: M) => void,
  ): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    let loaded: M | null = null;
    try {
      loaded = await load();
    } catch {
      // reported below
    } finally {
      this.loading = false;
    }
    if (this.destroyed) return;
    if (!loaded) this.onLoadFailure(failureMessage);
    else if (isCurrent()) show(loaded);
  }
}
