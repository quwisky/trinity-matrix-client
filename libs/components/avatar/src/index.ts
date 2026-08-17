// @trinity/components/avatar — Trinity's avatar, and the tier's home for its resolver seam.
//
// Moved here from @trinity/ui with the rest of the presentational components: this lib
// wraps the kit's avatar primitive (`@trinity/helm/avatar`), and naming a kit library is
// the public tier's job — while it lived in `ui:wrapper` that import needed a staged
// exception in the consumer-side kit ban. The `AVATAR_RESOLVER` token stays beside the
// component: it is the DI seam `main.ts` wires to `AvatarService.resolve`, and absent a
// provider the component falls back to its `url` input (ui in isolation, unit tests).
export * from './lib/avatar.component';
export * from './lib/avatar-resolver';
