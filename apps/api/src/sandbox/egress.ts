import { SandboxError } from './provider.js';

export const ALL_TRAFFIC = '0.0.0.0/0';

export const BLOCKED_RANGES: readonly string[] = [
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

export const EGRESS_ALLOWED_HOSTS: readonly string[] = [
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'registry.npmjs.org',
];

export const MAX_EGRESS_HOSTS = 8;
export const MAX_EGRESS_SECONDS = 300;

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;
const INTERNAL_SUFFIXES: readonly string[] = [
  '.internal',
  '.local',
  '.localdomain',
  '.localhost',
  '.cluster',
  '.svc',
];

export interface EgressPolicy {
  allowOut?: string[];
  denyOut: string[];
}

export function looksLikeAddress(host: string): boolean {
  return IPV4_PATTERN.test(host) || host.includes(':') || /^\d+$/.test(host);
}

export function closedNetwork(): EgressPolicy {
  return { denyOut: [ALL_TRAFFIC] };
}

export function assertEgressHost(host: string): void {
  const cleaned = host.trim().toLowerCase();

  if (cleaned !== host) {
    throw new SandboxError('SANDBOX_EGRESS_REFUSED', 'That host is not written in a usable form.');
  }

  if (looksLikeAddress(cleaned)) {
    throw new SandboxError(
      'SANDBOX_EGRESS_REFUSED',
      'A sandbox may only reach a named host, never an address.',
    );
  }

  if (!HOSTNAME_PATTERN.test(cleaned)) {
    throw new SandboxError('SANDBOX_EGRESS_REFUSED', 'That host is not written in a usable form.');
  }

  if (INTERNAL_SUFFIXES.some((suffix) => cleaned.endsWith(suffix))) {
    throw new SandboxError('SANDBOX_EGRESS_REFUSED', 'A sandbox may never reach an internal name.');
  }

  if (!EGRESS_ALLOWED_HOSTS.includes(cleaned)) {
    throw new SandboxError(
      'SANDBOX_EGRESS_REFUSED',
      'That host is not on the list a sandbox may reach.',
    );
  }
}

export function openedNetwork(hosts: readonly string[]): EgressPolicy {
  if (hosts.length === 0 || hosts.length > MAX_EGRESS_HOSTS) {
    throw new SandboxError('SANDBOX_EGRESS_REFUSED', 'That set of hosts cannot be opened.');
  }

  for (const host of hosts) {
    assertEgressHost(host);
  }

  return {
    allowOut: [...new Set(hosts)],
    denyOut: [ALL_TRAFFIC, ...BLOCKED_RANGES],
  };
}

export function assertEgressSeconds(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_EGRESS_SECONDS) {
    throw new SandboxError('SANDBOX_EGRESS_REFUSED', 'That network window is out of range.');
  }
}
