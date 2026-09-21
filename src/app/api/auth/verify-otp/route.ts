import { NextRequest, NextResponse } from "next/server";
import { verifyOtp, OtpError } from "../../../../lib/auth/otp";
import { getRedis, RedisNotConfiguredError } from "../../../../lib/redis";
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SessionConfigError,
} from "../../../../lib/auth/session";
import { prisma } from "../../../../lib/db";

const PHONE_PATTERN = /^\+?[1-9]\d{9,14}$/;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";

  if (!PHONE_PATTERN.test(phone) || !/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "Valid phone and 6-digit code are required" }, { status: 400 });
  }

  try {
    await verifyOtp(getRedis(), phone, code);
  } catch (err) {
    if (err instanceof RedisNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    if (err instanceof OtpError) {
      const statusByCode: Record<string, number> = {
        EXPIRED_OR_NOT_FOUND: 410,
        TOO_MANY_ATTEMPTS: 429,
        INCORRECT: 401,
        COOLDOWN: 429,
      };
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: statusByCode[err.code] ?? 400 }
      );
    }
    // eslint-disable-next-line no-console
    console.error("[auth:verify-otp] unexpected error", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  let user;
  try {
    user = await prisma.user.findUnique({ where: { phone }, include: { entity: true } });

    if (!user) {
      const entity = await prisma.entity.create({
        data: {
          legalName: `Unverified entity (${phone})`,
          entityType: "JEWELLER",
        },
      });
      user = await prisma.user.create({
        data: { phone, entityId: entity.id, role: "ENTITY_ADMIN" },
        include: { entity: true },
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[auth:verify-otp] database error creating/finding user", err);
    return NextResponse.json(
      { error: "Could not complete login - database error. Is DATABASE_URL set and migrated?" },
      { status: 500 }
    );
  }

  let token: string;
  try {
    token = await createSessionToken({ userId: user.id, entityId: user.entityId, phone: user.phone });
  } catch (err) {
    if (err instanceof SessionConfigError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  const response = NextResponse.json({
    userId: user.id,
    entityId: user.entityId,
    phone: user.phone,
    kycStatus: user.entity.kycStatus,
    legalName: user.entity.legalName,
  });

  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });

  return response;
}
