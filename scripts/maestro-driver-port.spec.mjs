import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  allocateMaestroDriverPort,
  parseAndroidPortState,
} from '../e2e/android/maestro-driver-port.mts';

const ipv4Header = 'sl local_address rem_address st tx_queue rx_queue';
const ipv6Header = 'sl local_address remote_address st tx_queue rx_queue';
const snapshot = (range = '32768 60999', rows4 = '', rows6 = '') =>
  `${range}\n${ipv4Header}\n${rows4}\n${ipv6Header}\n${rows6}\n`;
const row = (port, state = '0A', ipv6 = false) =>
  `0: ${'0'.repeat(ipv6 ? 32 : 8)}:${port.toString(16).padStart(4, '0')} ${'0'.repeat(ipv6 ? 32 : 8)}:0000 ${state} 00000000:00000000`;

describe('Maestro driver port allocation across host and Android', () => {
  it('excludes Android listeners, outbound connections and TIME_WAIT on both families', () => {
    const state = parseAndroidPortState(
      snapshot(
        '32768\t60999',
        `${row(1024)}\n${row(43515, '01')}`,
        row(1025, '06', true),
      ),
    );
    expect(state.ephemeralRange).toEqual([32768, 60999]);
    expect([...state.occupiedPorts].sort((a, b) => a - b)).toEqual([
      1024, 1025, 43515,
    ]);
  });

  it.each([
    ['missing range', `${ipv4Header}\n${ipv6Header}`],
    ['reversed range', snapshot('60999 32768')],
    ['out-of-range endpoint', snapshot('32768 65536')],
    ['missing IPv6 table', `32768 60999\n${ipv4Header}\n`],
    ['duplicated IPv4 table', `32768 60999\n${ipv4Header}\n${ipv4Header}\n`],
    ['unparseable socket', snapshot('32768 60999', '0: garbage')],
    [
      'permission failure in output',
      snapshot('32768 60999', 'cat: /proc/net/tcp: Permission denied'),
    ],
  ])('rejects %s instead of assuming the device is clear', (_, value) => {
    expect(() => parseAndroidPortState(value)).toThrow();
  });

  it('allocates outside Android ephemeral ports and avoids every occupied or already-used port', async () => {
    const state = parseAndroidPortState(
      snapshot('1024 32000', row(32001), row(32002, '06', true)),
    );
    const used = new Set([32003]);
    const port = await allocateMaestroDriverPort(state, used);
    expect(port).toBeGreaterThan(32003);
    expect(port).toBeLessThanOrEqual(65535);
    expect(state.occupiedPorts.has(port)).toBe(false);
    expect(used.has(port)).toBe(false);
  });

  it('rejects an exhausted non-ephemeral device range', async () => {
    const state = parseAndroidPortState(snapshot('1024 65535'));
    await expect(allocateMaestroDriverPort(state, new Set())).rejects.toThrow(
      'No available',
    );
  });

  it('probes the wildcard host socket so another interface cannot hide a collision', async () => {
    const occupied = createServer();
    await new Promise((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen(0, '127.0.0.1', resolve);
    });
    try {
      const blockedPort = occupied.address().port;
      // Make this host-occupied port the only device-eligible candidate.
      const used = new Set();
      for (let port = 1024; port <= 65535; port++) {
        if (port !== blockedPort) used.add(port);
      }
      const state = parseAndroidPortState(snapshot('1 1023'));
      await expect(allocateMaestroDriverPort(state, used)).rejects.toThrow(
        'No available',
      );
    } finally {
      await new Promise((resolve, reject) =>
        occupied.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
