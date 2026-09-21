/**
 * Session Management
 * ---------------------------------------------------------------------------
 * A signed JWT (via jose, which works in both Node and Edge runtimes)
 * stored in an httpOnly, secure cookie. Not stored in Postgres or Redis -
 * the token itself is the session; verifying its signature is enough,
 * which keeps every route's auth check to a single fast, stateless call.
 *
 * Deliberately minimal: userId/entityId/phone only. Anything else a route
 * needs about the user (role, KYC status) should be looked up fresh from
 * Postgres when it matters, not baked into a token that could go stale for
 * up to the token's full lifetime.
 */

import { SignJWT, jwtVerify } from "jose";
import type { NextRequest } from "next/server";

export const SESSION_COOKIE_NAME = "bullion_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface SessionPayload {
  userId: string;
  entityId: string;
  phone: string;
}

export class SessionConfigError extends Error {
  constructor() {
    super(
      "AUTH_JWT_SECRET is not set. Set it to a long, random string in your " +
        "deployment environment - sessions cannot be signed or verified " +
        "without it."
    );
    this.name = "SessionConfigError";
  }
}

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) throw new SessionConfigError();
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSecret());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (
      typeof payload.userId !== "string" ||
      typeof payload.entityId !== "string" ||
      typeof payload.phone !== "string"
    ) {
      return null;
    }
    return { userId: payload.userId, entityId: payload.entityId, phone: payload.phone };
  } catch {
    return null;
  }
}

export async function getSession(req: NextRequest): Promise<SessionPayload | null> {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export const SESSION_COOKIE_MAX_AGE_SECONDS = SESSION_TTL_SECONDS;
