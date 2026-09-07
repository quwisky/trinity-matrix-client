/** GitHub artifact coordinates and staging; payload identity stays in web-bundle-manifest. */
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  currentCommit,
  readWebBundleManifest,
  sha256,
  verifyWebBundleRoot,
  writeWebBundleManifest,
} from './web-bundle-manifest.mjs';

const manifestPath = 'dist/web-bundle-manifest.json';

export function validateCoordinates(input) {
  if (
    !/^[a-f0-9]{40}$/.test(input.sha ?? '') ||
    !/^[1-9][0-9]*$/.test(input.runId ?? '') ||
    !/^[1-9][0-9]*$/.test(input.artifactId ?? '') ||
    !/^[a-f0-9]{64}$/.test(input.digest ?? '') ||
    !/^[a-zA-Z0-9_-]+$/.test(input.artifactName ?? '')
  ) {
    throw new Error(
      'Renderer requires explicit full SHA, run ID, artifact ID/name and manifest digest',
    );
  }
}

export function validateArtifactMetadata(artifact, input) {
  validateCoordinates(input);
  if (
    String(artifact?.id) !== input.artifactId ||
    artifact?.name !== input.artifactName ||
    String(artifact?.workflow_run?.id) !== input.runId ||
    artifact?.expired !== false ||
    !(Date.parse(artifact?.expires_at) > Date.now())
  ) {
    throw new Error(
      'Renderer artifact is expired or does not match the requested run/ID/name',
    );
  }
  // workflow_run.head_sha is the PR head, while the renderer may be built from
  // the merge commit. The trusted expected manifest digest binds the checkout SHA.
}

export function stagingDirectory(root, destination) {
  if (!/^dist\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(destination ?? '')) {
    throw new Error(
      'Renderer staging destination must be a directory below dist/',
    );
  }
  let path = root;
  for (const part of destination.split('/')) {
    path = join(path, part);
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry && !entry.isDirectory()) {
      throw new Error(
        'Renderer staging destination contains an unsafe filesystem entry',
      );
    }
  }
  return path;
}

export function restoreRenderer(root, destination, input) {
  validateCoordinates(input);
  const staging = stagingDirectory(root, destination);
  if (
    readdirSync(staging).sort().join(',') !== 'dist,www' ||
    !lstatSync(join(staging, 'dist')).isDirectory() ||
    readdirSync(join(staging, 'dist')).sort().join(',') !==
      'web-bundle-manifest.json,web-bundle-manifest.json.sha256'
  ) {
    throw new Error('Unexpected renderer artifact layout');
  }
  for (const name of [manifestPath, `${manifestPath}.sha256`]) {
    if (!lstatSync(join(staging, name)).isFile())
      throw new Error('Unsafe renderer manifest entry');
  }
  const manifest = readWebBundleManifest(
    join(staging, manifestPath),
    input.digest,
  );
  if (
    readFileSync(join(staging, `${manifestPath}.sha256`), 'utf8') !==
    `${input.digest}  web-bundle-manifest.json\n`
  ) {
    throw new Error('Renderer manifest checksum file does not match');
  }
  verifyWebBundleRoot(join(staging, 'www'), manifest, {
    expectedSha: input.sha,
  });
  // Only replace the canonical generated payload after all input checks pass.
  const target = join(root, 'www');
  const targetEntry = lstatSync(target, { throwIfNoEntry: false });
  if (targetEntry && !targetEntry.isDirectory())
    throw new Error('Unsafe www destination');
  for (const name of [manifestPath, `${manifestPath}.sha256`]) {
    const entry = lstatSync(join(root, name), { throwIfNoEntry: false });
    if (entry && !entry.isFile())
      throw new Error('Unsafe manifest destination');
  }
  rmSync(target, { recursive: true, force: true });
  cpSync(join(staging, 'www'), target, { recursive: true });
  for (const name of [manifestPath, `${manifestPath}.sha256`]) {
    const targetFile = join(root, name);
    copyFileSync(join(staging, name), targetFile);
  }
  verifyWebBundleRoot(
    target,
    readWebBundleManifest(join(root, manifestPath), input.digest),
    { expectedSha: input.sha },
  );
}

const output = (path, text) => {
  if (path) appendFileSync(path, text);
};

async function main() {
  const env = process.env;
  const root = process.cwd();
  if (env.TRINITY_RENDERER_SHA !== currentCommit())
    throw new Error('Renderer SHA differs from checked-out commit');
  const [command] = process.argv.slice(2);
  if (command === 'assert-source') {
    if (
      env.RENDERER_ARTIFACT_NAME !==
      `renderer-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${env.TRINITY_RENDERER_SHA}`
    ) {
      throw new Error('Renderer artifact name must bind run, attempt and SHA');
    }
    return;
  }
  if (command === 'record') {
    const manifest = writeWebBundleManifest(join(root, 'www'));
    verifyWebBundleRoot(join(root, 'www'), manifest);
    const digest = sha256(readFileSync(manifestPath));
    writeFileSync(
      `${manifestPath}.sha256`,
      `${digest}  web-bundle-manifest.json\n`,
    );
    output(
      env.GITHUB_OUTPUT,
      `manifest-digest=${digest}\nsha=${manifest.commitSha}\n`,
    );
    output(
      env.GITHUB_STEP_SUMMARY,
      `Production renderer compilations: 1\n\nCommit: ${manifest.commitSha}\n\nManifest SHA-256: ${digest}\n\nFiles: ${manifest.files.length}; bytes: ${manifest.totalBytes}\n`,
    );
    return;
  }
  const input = {
    sha: env.TRINITY_RENDERER_SHA,
    runId: env.RENDERER_SOURCE_RUN_ID,
    artifactId: env.RENDERER_ARTIFACT_ID,
    artifactName: env.RENDERER_ARTIFACT_NAME,
    digest: env.TRINITY_RENDERER_MANIFEST_DIGEST,
  };
  validateCoordinates(input);
  const destination = env.RENDERER_DESTINATION;
  if (command === 'prepare') {
    const repository = env.GITHUB_REPOSITORY;
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository ?? ''))
      throw new Error('Invalid repository');
    const response = await fetch(
      `https://api.github.com/repos/${repository}/actions/artifacts/${input.artifactId}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${env.GH_TOKEN}`,
          'X-GitHub-Api-Version': '2026-03-10',
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new Error(
        `Renderer artifact lookup failed: HTTP ${response.status}`,
      );
    validateArtifactMetadata(await response.json(), input);
    const staging = stagingDirectory(root, destination);
    mkdirSync(staging, { recursive: true });
    if (readdirSync(staging).length !== 0)
      throw new Error('Renderer staging destination must be empty');
    return;
  }
  if (command !== 'restore')
    throw new Error('Expected record, prepare or restore');
  restoreRenderer(root, destination, input);
  output(
    env.GITHUB_ENV,
    `TRINITY_RENDERER_SHA=${input.sha}\nTRINITY_RENDERER_MANIFEST_DIGEST=${input.digest}\nTRINITY_E2E_PREBUILT_WWW=1\n`,
  );
  output(
    env.GITHUB_STEP_SUMMARY,
    `Verified renderer: ${input.sha}\n\nManifest SHA-256: ${input.digest}\n\nSource run/artifact: ${input.runId}/${input.artifactId} (${input.artifactName})\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
