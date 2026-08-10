import { OtpRequestBodySchema, OtpRequestResponseSchema } from '@nimbus/contracts';
import { Router } from 'express';

import type { RequestCodeInput, RequestCodeResult } from '../../auth/otp-service.js';
import { validateBody, validatedBody } from '../middleware/validate.js';

export const UNKNOWN_CLIENT_IP = 'unknown';

export interface OtpRequestService {
  requestCode(input: RequestCodeInput): Promise<RequestCodeResult>;
}

export interface AuthRouterOptions {
  otp: OtpRequestService;
}

export function clientIp(ip: string | undefined): string {
  return ip === undefined || ip === '' ? UNKNOWN_CLIENT_IP : ip;
}

export function createAuthRouter(options: AuthRouterOptions): Router {
  const router = Router();

  router.post(
    '/auth/otp/request',
    validateBody(OtpRequestBodySchema),
    async (request, response) => {
      const body = validatedBody(request, OtpRequestBodySchema);

      const result = await options.otp.requestCode({
        email: body.email,
        ip: clientIp(request.ip),
      });

      response.status(202).json(OtpRequestResponseSchema.parse(result));
    },
  );

  return router;
}
