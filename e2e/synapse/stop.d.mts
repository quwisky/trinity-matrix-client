// Type declarations for stop.mjs — see start.d.mts for why the harness stays plain JS.

/**
 * Tear the disposable Synapse stack down.
 *
 * @param opts.keepData keep the compose volumes, so the next `start()` reuses the
 *   already-registered accounts instead of re-seeding them.
 */
export declare function stop(opts?: { keepData?: boolean }): Promise<void>;
