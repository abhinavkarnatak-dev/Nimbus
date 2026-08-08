import { CONTRACTS_VERSION } from '@nimbus/contracts';

export const API_NAME = 'nimbus-api' as const;

export function describeBuild(): string {
  return `${API_NAME} (contracts ${CONTRACTS_VERSION})`;
}
