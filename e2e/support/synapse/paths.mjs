// Where the harness keeps the state Docker bind-mounts, and which compose files describe
// the stack. Shared by start.mjs and stop.mjs so the two can never disagree.
//
// Why this is not simply `__dirname`: a bind mount is resolved by the Docker DAEMON,
// against the daemon's own filesystem. That is our filesystem on a developer machine and
// on a GitHub-hosted runner (the job runs directly on the VM) — but not when the job is
// itself a container talking to a separate daemon, as under Forgejo's act_runner. There
// the path we hand to `-v` is one the daemon resolves somewhere else entirely: it
// silently creates an empty directory, our ./data stays empty, and the next read of
// homeserver.yaml throws ENOENT.
//
// Both knobs below are opt-in and unset by default, so every existing environment keeps
// the exact behaviour it has today.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** The support-owned Synapse directory: compose files, Caddyfile, and adapters. */
export const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Root of the harness's mutable, bind-mounted state.
 *
 * `TRINITY_E2E_STATE_DIR` fixes the mismatch above *by construction* rather than by
 * detection: point it at a directory that means the same thing to us and to the daemon —
 * under act_runner, a path beneath the `/workspace` both the job and the dind daemon
 * mount from the same host directory — and every bind mount resolves to the same bytes
 * from either side. Pick a path OUTSIDE the repo checkout: act_runner mounts the
 * workspace over the checkout path, which shadows the shared bind underneath it.
 */
export const STATE_DIR = process.env['TRINITY_E2E_STATE_DIR']
  ? resolve(process.env['TRINITY_E2E_STATE_DIR'])
  : HERE;

/** Generated Synapse state: homeserver.yaml, the signing key, the sqlite DB, media. */
export const DATA = join(STATE_DIR, 'data');
/** Generated state for the genuinely federated secondary homeserver. */
export const REMOTE_DATA = join(STATE_DIR, 'remote-data');

/** True when this process is itself running inside a container. */
function inContainer() {
  return existsSync('/.dockerenv') || existsSync('/run/.containerenv');
}

/**
 * Ways to learn our own container id, best first.
 *
 * mountinfo leads because it survives a custom hostname: the daemon bind-mounts
 * /etc/hosts and friends out of /var/lib/docker/containers/<id>/, so the id is in the
 * mount source even when HOSTNAME has been overridden (measured — act_runner names its
 * job containers, so the hostname cannot be relied on). cgroup is not consulted: under
 * cgroup v2 it is just "0::/".
 */
async function selfContainerCandidates() {
  const found = [];
  try {
    const mountinfo = await readFile('/proc/self/mountinfo', 'utf8');
    const match = mountinfo.match(/containers\/([0-9a-f]{64})/);
    if (match) found.push(match[1]);
  } catch {
    /* not Linux, or no procfs — fall through to the hostname guesses */
  }
  try {
    found.push((await readFile('/etc/hostname', 'utf8')).trim());
  } catch {
    /* ignore */
  }
  if (process.env['HOSTNAME']) found.push(process.env['HOSTNAME']);
  return found.filter(Boolean);
}

/**
 * The container whose network namespace the stack should join, or '' to publish ports.
 *
 * Publishing only works when the job and the Docker daemon share a loopback — true on a
 * developer machine and on a GitHub-hosted runner, false when the job is a container
 * talking to a separate daemon (Forgejo's act_runner with a dind sidecar). There, compose
 * publishes to the daemon's loopback and the job cannot reach Synapse at all: the symptom
 * is a `/health` timeout after a successful `compose up`.
 *
 * Detection rather than configuration, because the id is per-job and cannot be a static
 * runner env; `${{ job.container.id }}` is not an answer either, since act_runner does not
 * populate that context. TRINITY_E2E_NETWORK_CONTAINER still overrides everything.
 */
export async function resolveNetworkContainer() {
  const explicit = process.env['TRINITY_E2E_NETWORK_CONTAINER'];
  if (explicit) {
    return explicit;
  }
  if (!inContainer()) {
    return '';
  }
  for (const candidate of await selfContainerCandidates()) {
    try {
      const { stdout } = await exec('docker', [
        'inspect',
        '--format',
        '{{.Id}}',
        candidate,
      ]);
      return stdout.trim();
    } catch {
      /* the daemon does not know this one — try the next */
    }
  }
  throw new Error(
    'Running inside a container, but could not work out which one to share a network ' +
      'namespace with — so the published ports would be unreachable and Synapse would ' +
      'time out. Set TRINITY_E2E_NETWORK_CONTAINER to this job container id or name.',
  );
}

/** `-f` arguments for docker compose, in override order. */
export function composeFiles(networkContainer) {
  const files = ['-f', join(HERE, 'docker-compose.yml')];
  if (networkContainer) {
    files.push('-f', join(HERE, 'docker-compose.netns.yml'));
  }
  return files;
}

/**
 * Make the state directory usable: create it, and put the config files the compose
 * mounts expect where they expect them. Caddy and Dex each bind-mount a single file, so
 * those have to live beside the state rather than in the repo whenever the two are
 * different places — and they must exist first, or the daemon helpfully creates a
 * *directory* at the mount point and the container fails to parse its config.
 */
export async function prepareStateDir() {
  await Promise.all([
    mkdir(DATA, { recursive: true }),
    mkdir(REMOTE_DATA, { recursive: true }),
  ]);
  if (STATE_DIR !== HERE) {
    for (const file of ['Caddyfile', 'dex.yaml']) {
      await copyFile(join(HERE, file), join(STATE_DIR, file));
    }
  }
  // Dex runs unprivileged and must be able to read the bind-mounted config even when
  // the checkout inherited a restrictive umask (some worktree/copy setups use 0600).
  await Promise.all(
    ['Caddyfile', 'dex.yaml'].map((file) =>
      chmod(join(STATE_DIR, file), 0o644),
    ),
  );
}
