// The browser session's cookie (AD-047). Read by the auth hook and the live connection.
import type { FastifyRequest } from 'fastify';

export const COOKIE = 'kw_session';

/** The session cookie, also the one of the old app (AD-053; it is replaced at the next sign-in). */
export const sessionCookie = (req: FastifyRequest): string | undefined => req.cookies[COOKIE];
