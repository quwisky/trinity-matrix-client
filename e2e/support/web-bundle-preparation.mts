import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runManagedCommand,
  type ManagedCommandResult,
} from './managed-command.mts';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface WebBundlePreparation {
  readonly buildTarget?: string;
  readonly bundleManifest: boolean;
  readonly reusePrebuilt: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}

export type ExecuteWebBundleCommand = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof runManagedCommand>[2],
) => Promise<ManagedCommandResult>;

/** Build and record, or explicitly verify, the shared production web payload. */
export async function prepareWebBundle(
  options: WebBundlePreparation,
  execute: ExecuteWebBundleCommand = runManagedCommand,
): Promise<number> {
  if (
    options.bundleManifest &&
    !options.buildTarget &&
    !options.reusePrebuilt
  ) {
    throw new Error(
      '--bundle-manifest requires --build=<target> or TRINITY_E2E_PREBUILT_WWW=1',
    );
  }
  if (options.buildTarget && !options.reusePrebuilt) {
    const build = await execute(
      'pnpm',
      ['exec', 'nx', 'run', options.buildTarget],
      {
        cwd: workspaceRoot,
        environment: options.environment,
        timeout: 600_000,
        signal: options.signal,
      },
    );
    if (build.status !== 0) return build.status;
  }
  if (!options.bundleManifest) return 0;

  const manifest = await execute(
    process.execPath,
    options.reusePrebuilt
      ? [
          'scripts/web-bundle-manifest.mjs',
          'verify',
          'dist/web-bundle-manifest.json',
          'www',
        ]
      : ['scripts/web-bundle-manifest.mjs', 'write', 'www'],
    {
      cwd: workspaceRoot,
      environment: options.environment,
      timeout: 60_000,
      signal: options.signal,
    },
  );
  if (manifest.status === 0) {
    options.environment['TRINITY_E2E_PREBUILT_WWW'] = '1';
  }
  return manifest.status;
}

export { workspaceRoot as webBundleWorkspaceRoot };
