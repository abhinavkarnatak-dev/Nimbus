export const ALERT_NAMES = [
  'auth_failures_repeated',
  'policy_denied',
  'sandbox_cleanup_failed',
  'budget_spike',
  'webhook_failed',
  'push_anomaly',
  'pull_request_anomaly',
  'provider_key_rejected',
  'rate_limited',
] as const;

export type AlertName = (typeof ALERT_NAMES)[number];

export function alerting<T extends Record<string, unknown>>(
  name: AlertName,
  detail: T,
): T & { alert: AlertName } {
  return { ...detail, alert: name };
}
