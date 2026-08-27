import type { NextFunction, Request, Response } from 'express';
import type { AccessMode } from '@scp/contracts';

export interface AuthContext {
  userId: string;
  accessMode: AccessMode;
  client?: string;
  /** Opaque token forwarded to kagent when identity propagation is enabled. */
  token?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Pilot authentication: a shared bearer token plus a user header (SPEC §16).
 *
 * Deliberately replaceable - swap this middleware for OIDC or reverse-proxy auth
 * without touching any route. Access is never anonymous: a missing or wrong
 * token is rejected before any agent is reached.
 */
export function bearerAuth(expectedToken: string) {
  if (!expectedToken) {
    throw new Error(
      'SCP_API_TOKEN is required. Refusing to start an unauthenticated agent gateway.',
    );
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const presented = /^Bearer\s+(.+)$/i.exec(header.trim())?.[1];
    if (!presented) {
      res.status(401).json({ error: 'missing bearer token' });
      return;
    }
    if (!timingSafeEqual(presented, expectedToken)) {
      res.status(401).json({ error: 'invalid token' });
      return;
    }

    const userId = req.header('x-scp-user') ?? 'unknown-user';
    req.auth = {
      userId,
      accessMode: 'portal',
      client: req.header('x-scp-client') ?? 'scp-portal',
      token: presented,
    };
    next();
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
