// Opt-in call stack (TRINITY_E2E_CALLS=1): MatrixRTC settings for the primary Synapse. The
// services are in docker-compose.yml beside this file; start.mjs drives readiness.
import { join } from 'node:path';
import { LIVEKIT_TLS } from '../constants.mjs';
import { STATE_DIR } from '../paths.mjs';

const START = '# === trinity-e2e-calls (regenerated every start) ===';
const END = '# === end trinity-e2e-calls ===';
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const REGION = new RegExp(`\\n*${escape(START)}[\\s\\S]*?${escape(END)}\\n*`);

/**
 * The homeserver.yaml with the calls region added (`enabled`) or removed. Rewritten on
 * every start, because the region names a registration only calls/docker-compose.yml
 * mounts: left in place without the stack, Synapse would not start.
 */
export function withCalls(yaml, enabled) {
  const base = yaml.replace(REGION, '\n');
  if (!enabled) return base === yaml ? yaml : `${base.replace(/\s+$/, '')}\n`;
  return `${base.replace(/\s+$/, '')}\n\n${[
    START,
    'app_service_config_files:',
    '  - /calls/app-service.yaml',
    // MSC4140 delayed events, which MatrixRTC leaves with, are on only with a maximum delay.
    'max_event_delay_duration: 24h',
    'rc_delayed_event_mgmt:',
    '  per_second: 100',
    '  burst_count: 100',
    'matrix_rtc:',
    '  transports:',
    '    - type: livekit',
    `      url: ${LIVEKIT_TLS}`,
    'experimental_features:',
    '  msc4143_enabled: true',
    '  msc4354_enabled: true',
    '  msc4502_enabled: true',
    '  msc4512_enabled: true',
    END,
  ].join('\n')}\n`;
}

/** Config files whose change must restart a running service (see start.mjs). */
export const callsMountedConfig = {
  livekit: join(STATE_DIR, 'calls', 'livekit.yaml'),
  'lk-jwt': join(STATE_DIR, 'calls', 'app-service.yaml'),
};

/** The committed files the stack mounts, copied beside the state when it lives elsewhere. */
export const CALLS_CONFIG_FILES = [
  'calls/livekit.yaml',
  'calls/app-service.yaml',
];
