import { describe, expect, it } from 'vitest';
import {
  validateCurrentWebHost,
  validateWebHostContract,
} from './web-host-contract.mjs';

function validInput() {
  return {
    project: {
      tags: ['type:app', 'role:app', 'capability:composition'],
      targets: {
        build: {
          executor: '@angular/build:application',
          outputs: ['{workspaceRoot}/www'],
          options: {
            outputPath: { base: 'www', browser: '' },
            assets: [
              {
                glob: 'matrix_sdk_crypto_wasm_bg.wasm',
                output: 'assets/crypto',
              },
            ],
          },
          configurations: {
            production: {
              serviceWorker: 'apps/trinity/ngsw-config.json',
            },
          },
        },
      },
    },
    e2eProject: {
      targets: {
        'web-e2e': {
          options: {
            command: 'pnpm exec nx run trinity-e2e-web:production-pwa',
          },
        },
      },
    },
    webE2EProject: {
      targets: {
        'production-pwa': {
          options: {
            command:
              'node e2e/support/run-playwright.mts --config=e2e/web/playwright.production-pwa.config.mts --build=trinity:build:production --bundle-manifest',
          },
        },
      },
    },
    main: [
      "import { provideTrinityApplication, startApplicationRuntime } from '@trinity/application/runtime';",
      'provideTrinityApplication({',
      'provideServiceWorker(',
      '!isInstalledNativePlatform()',
      '!isElectronRenderer()',
      '.then(startApplicationRuntime)',
    ].join('\n'),
    composition: [
      'provideBrowserGlobalErrorListeners()',
      'provide: APPLICATION_RUNTIME_ADAPTER',
      'provide: WORKSPACE_APPLICATION_SURFACE_PRESENTER',
      'applicationCapabilityProviders(options)',
    ].join('\n'),
    capacitor: "webDir: 'www'",
    electron: "const src = join(repoRoot, 'www')",
    ngsw: {
      assetGroups: [
        {
          name: 'app',
          installMode: 'prefetch',
          resources: {
            files: [
              '/manifest.webmanifest',
              ...LAZY_CHUNKS.map((c) => `!${c}`),
            ],
          },
        },
        {
          name: 'lazy-features',
          installMode: 'lazy',
          resources: { files: LAZY_CHUNKS },
        },
        {
          name: 'assets',
          installMode: 'prefetch',
          resources: { files: ['/assets/**'] },
        },
      ],
    },
  };
}

const LAZY_CHUNKS = ['/config-editor.component-*.js'];

function errorsAfter(mutate) {
  const input = validInput();
  mutate(input);
  const errors = [];
  validateWebHostContract(input, errors);
  return errors;
}

describe('web host contract', () => {
  it('validates the production host', () => {
    expect(validateCurrentWebHost).not.toThrow();
  });

  it('rejects product implementation imports from the thin host', () => {
    const errors = errorsAfter((input) => {
      input.main +=
        "\nimport { PushService } from '@trinity/data-access/notifications';";
    });

    expect(errors).toContain(
      'Web host main.ts imports product implementation: @trinity/data-access/notifications',
    );
  });

  it('rejects side-effect product implementation imports from the thin host', () => {
    const errors = errorsAfter((input) => {
      input.main += "\nimport '@trinity/feature/settings';";
    });

    expect(errors).toContain(
      'Web host main.ts imports product implementation: @trinity/feature/settings',
    );
  });

  it('does not accept required ownership markers in comments', () => {
    const errors = errorsAfter((input) => {
      input.composition = input.composition.replace(
        'applicationCapabilityProviders(options)',
        '// applicationCapabilityProviders(options)',
      );
    });

    expect(errors).toContain(
      'Application composition is missing ownership marker: applicationCapabilityProviders(options)',
    );
  });

  it('does not accept required ownership markers in string literals', () => {
    const errors = errorsAfter((input) => {
      input.composition = input.composition.replace(
        'applicationCapabilityProviders(options)',
        "const decoy = 'applicationCapabilityProviders(options)'",
      );
    });

    expect(errors).toContain(
      'Application composition is missing ownership marker: applicationCapabilityProviders(options)',
    );
  });

  it('requires the imported application runtime starter to be invoked', () => {
    const errors = errorsAfter((input) => {
      input.main = input.main.replace('.then(startApplicationRuntime)', '');
    });

    expect(errors).toContain(
      'Web host main.ts is missing composition marker: .then(startApplicationRuntime)',
    );
  });

  it('keeps the config editor chunk out of the install prefetch', () => {
    const prefetched = errorsAfter((input) => {
      const app = input.ngsw.assetGroups.find((g) => g.name === 'app');
      app.resources.files = ['/manifest.webmanifest', '/*.js'];
    });
    const missing = errorsAfter((input) => {
      input.ngsw.assetGroups = input.ngsw.assetGroups.filter(
        (g) => g.name !== 'lazy-features',
      );
    });

    expect(prefetched).toContain(
      'Web service worker must not prefetch /config-editor.component-*.js',
    );
    expect(missing).toContain(
      'Web service worker must cache /config-editor.component-*.js lazily',
    );
  });

  it('rejects a host artifact that diverges from wrapper input', () => {
    const errors = errorsAfter((input) => {
      input.project.targets.build.options.outputPath.base = 'dist/web';
    });

    expect(errors).toContain(
      'Web host build must emit the flat shared www artifact',
    );
  });
});
