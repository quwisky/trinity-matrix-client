export * from './lib/app.component';
export * from './lib/verification-host.component';
export * from './lib/navigation-focus.service';
// NOTE: ./lib/home.page is deliberately NOT re-exported. It is the dev-only E2EE
// spike harness, and this barrel is eagerly imported by main.ts for AppComponent — so
// re-exporting it drags the harness (and CryptoSpikeService) into the production eager
// chunk. The dev route deep-imports it instead.
