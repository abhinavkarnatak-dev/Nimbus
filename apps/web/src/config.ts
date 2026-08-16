const RAW_API_URL: unknown = import.meta.env['VITE_API_URL'];

export const API_BASE_URL =
  typeof RAW_API_URL === 'string' && RAW_API_URL.trim() !== ''
    ? RAW_API_URL.replace(/\/+$/, '')
    : 'http://localhost:4000';

export function socketUrlFor(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/^http/, 'ws');
}

export const SOCKET_URL = socketUrlFor(API_BASE_URL);
