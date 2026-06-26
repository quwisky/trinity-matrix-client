/**
 * Zone.js flags — must be set before `zone.js` is imported (see polyfills.ts).
 *
 * Ionic ships its UI as custom elements; letting Zone.js patch the custom
 * element lifecycle adds overhead and can cause spurious change detection, so
 * we opt out of that patch.
 */
(window as unknown as Record<string, boolean>)[
  '__Zone_disable_customElements'
] = true;
