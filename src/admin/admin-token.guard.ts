import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

/** Header the operator dashboard and any admin tooling send the token in. */
export const ADMIN_TOKEN_HEADER = 'x-admin-token';

/** Only the headers are needed here, and @types/express is not a dependency of this backend. */
interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Gates the admin plan-control endpoints behind ADMIN_API_TOKEN.
 *
 * These endpoints let one operator stop automation on another person's plan, so unlike the rest of
 * this backend they are not left open. With ADMIN_API_TOKEN unset the guard refuses every request
 * rather than waving them through — an unconfigured deployment must fail closed, because the
 * failure mode of the alternative is silent and total.
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.ADMIN_API_TOKEN?.trim();
    if (!expected) {
      throw new ServiceUnavailableException({
        ok: false,
        error:
          'Admin plan controls are disabled: set ADMIN_API_TOKEN on the backend to enable them.',
      });
    }

    const request = context.switchToHttp().getRequest<RequestWithHeaders>();
    const header = request.headers[ADMIN_TOKEN_HEADER];
    const provided = (Array.isArray(header) ? header[0] : header)?.trim() ?? '';

    if (!provided || !safeEquals(provided, expected)) {
      throw new UnauthorizedException({
        ok: false,
        error: `A valid ${ADMIN_TOKEN_HEADER} header is required.`,
      });
    }
    return true;
  }
}

/**
 * Constant-time compare. Length is compared first because timingSafeEqual throws on a mismatch;
 * that leaks the token's length, which is not the secret.
 */
function safeEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
