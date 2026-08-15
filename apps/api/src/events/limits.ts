export const SOCKET_LIMITS = {
  maxPayloadBytes: 8_192,
  maxSubscriptions: 4,
  messagesPerWindow: 40,
  windowMs: 10_000,
  badPayloadsAllowed: 10,
  revalidateMs: 60_000,
  replayPageSize: 500,
} as const;

export const CLOSE_CODES = {
  loggedOut: 4001,
  tooManyMessages: 4002,
  tooMuchNonsense: 4003,
  payloadTooLarge: 1009,
  goingAway: 1001,
} as const;

export type SocketLimits = typeof SOCKET_LIMITS;
