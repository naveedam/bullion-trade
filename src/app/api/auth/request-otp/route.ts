import { NextRequest, NextResponse } from "next/server";
import { requestOtp, OtpError } from "../../../../lib/auth/otp";
import { getRedis, RedisNotConfiguredError } from "../../../../lib/redis";
import { SmsProviderError } from "../../../../lib/auth/sms";

const PHONE_PATTERN = /^\+?[1-9]\d{9,14}$/;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";

  if (!PHONE_PATTERN.test(phone)) {
    return NextResponse.json(
      { error: "Enter a valid phone number with country code, e.g. +9198XXXXXXXX" },
      { status: 400 }
    );
  }

  try {
    const result = await requestOtp(getRedis(), phone);
    return NextResponse.json({
      sent: true,
      cooldownSeconds: result.cooldownSeconds,
      // Only populated when sms.ts's dev-echo path is active (local dev,
      // or ALLOW_SMS_DEV_ECHO=true on a real deployment for testing before
      // a real vendor is wired) — undefined otherwise, so this field is
      // simply absent from the response once a real vendor is in place.
      devEchoCode: result.devEchoCode,
    });
  } catch (err) {
    if (err instanceof RedisNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    if (err instanceof OtpError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 429 });
    }
    if (err instanceof SmsProviderError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    // eslint-disable-next-line no-console
    console.error("[auth:request-otp] unexpected error", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
