import { z } from 'zod';

import { IsoTimestampSchema, RequestIdSchema, UserIdSchema } from './ids.js';
import { LIMITS } from './limits.js';

export const EmailSchema = z
  .email({ error: 'Enter a valid email address' })
  .max(LIMITS.emailMaxChars);

export const OtpCodeSchema = z
  .string()
  .regex(new RegExp(`^[0-9]{${String(LIMITS.otpDigits)}}$`), { error: 'Enter the 8 digit code' });

export const AuthProviderSchema = z.enum(['email_otp', 'google']);

export const AUTH_PROVIDER_LABELS: Readonly<Record<AuthProvider, string>> = {
  email_otp: 'Email',
  google: 'Google',
};

export const OtpRequestBodySchema = z.strictObject({
  email: EmailSchema,
});

export const OtpRequestResponseSchema = z.strictObject({
  requestId: RequestIdSchema,
  expiresInSeconds: z.int().positive(),
  resendAvailableInSeconds: z.int().nonnegative(),
});

export const OtpVerifyBodySchema = z.strictObject({
  requestId: RequestIdSchema,
  email: EmailSchema,
  code: OtpCodeSchema,
});

export const AuthenticatedUserSchema = z.strictObject({
  userId: UserIdSchema,
  email: EmailSchema,
  displayName: z.string().min(1).max(LIMITS.displayNameMaxChars),
  avatarUrl: z.url().max(2048).optional(),
  authProviders: z.array(AuthProviderSchema).min(1),
  createdAt: IsoTimestampSchema,
  lastLoginAt: IsoTimestampSchema,
});

export const SessionContextSchema = z.strictObject({
  user: AuthenticatedUserSchema,
  csrfToken: z.string().min(16).max(256),
  hasActiveInstallation: z.boolean(),
  hasActiveSession: z.boolean(),
});

export const OtpVerifyResponseSchema = SessionContextSchema;
export const MeResponseSchema = SessionContextSchema;

export const LogoutResponseSchema = z.strictObject({
  loggedOut: z.literal(true),
});

export type Email = z.infer<typeof EmailSchema>;
export type AuthProvider = z.infer<typeof AuthProviderSchema>;
export type OtpRequestBody = z.infer<typeof OtpRequestBodySchema>;
export type OtpRequestResponse = z.infer<typeof OtpRequestResponseSchema>;
export type OtpVerifyBody = z.infer<typeof OtpVerifyBodySchema>;
export type AuthenticatedUser = z.infer<typeof AuthenticatedUserSchema>;
export type SessionContext = z.infer<typeof SessionContextSchema>;
export type OtpVerifyResponse = z.infer<typeof OtpVerifyResponseSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;
