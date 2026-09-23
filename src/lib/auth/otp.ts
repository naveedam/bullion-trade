/**
 * Phone OTP — Generation & Verification
 * ---------------------------------------------------------------------------
 * OTP codes live entirely in Redis, never in Postgres — they're short-lived
 * (5 minutes) and there's no reason to durably store them. Only a SHA-256
 * hash of the code is stored, never the plaintext, mirroring how the
 * platform never stores card/account numbers in the clear elsewhere.
 *
 * Rate limiting is enforced here, not just left to the SMS vendor's own
 * limits: a 60-second cooldown between sends per phone number, and a
 * 5-attempt cap on verification before the code is invalidated and a new
 * one has to be requested.
 */

import { createHash, randomInt } from "crypto";
import type Redis from "ioredis";
import { sendOtpSms } from "./sms";

const OTP_TTL_SECONDS = 5 * 60;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_VERIFY_ATTEMPTS = 5;

export class OtpError extends Error {
  constructor(
    message: string,
    public readonly code: "COOLDOWN" | "EXPIRED_OR_NOT_FOUND" | "TOO_MANY_ATTEMPTS" | "INCORRECT"
  ) {
    super(message);
    this.name = "OtpError";
  }
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function normalizePhone(phone: string): string {
  // Expect E.164-ish input ("+9198XXXXXXXX"); strip whitespace, keep the
  // leading + if present. Real validation (length, country code) belongs
  // in the API route, not here — this is just a cache-key normalizer.
  return phone.trim().replace(/\s+/g, "");
}

export interface RequestOtpResult {
  cooldownSeconds: number;
  devEchoCode?: string;
}

export async function requestOtp(redis: Redis, phoneRaw: string): Promise<RequestOtpResult> {
  const phone = normalizePhone(phoneRaw);
  const cooldownKey = `otp:cooldown:${phone}`;

  const onCooldown = await redis.get(cooldownKey);
  if (onCooldown) {
    const ttl = await redis.ttl(cooldownKey);
    throw new OtpError(
      `Please wait ${ttl}s before requesting another code`,
      "COOLDOWN"
    );
  }

  const code = randomInt(100000, 1000000).toString(); // 6 digits, zero-padded by range

  await redis.set(`otp:code:${phone}`, hashCode(code), "EX", OTP_TTL_SECONDS);
  await redis.set(`otp:attempts:${phone}`, "0", "EX", OTP_TTL_SECONDS);
  await redis.set(cooldownKey, "1", "EX", RESEND_COOLDOWN_SECONDS);

  const smsResult = await sendOtpSms(phone, code);

  return {
    cooldownSeconds: RESEND_COOLDOWN_SECONDS,
    devEchoCode: smsResult.devEchoCode,
  };
}

export async function verifyOtp(redis: Redis, phoneRaw: string, code: string): Promise<void> {
  const phone = normalizePhone(phoneRaw);
  const codeKey = `otp:code:${phone}`;
  const attemptsKey = `otp:attempts:${phone}`;

  const storedHash = await redis.get(codeKey);
  if (!storedHash) {
    throw new OtpError("Code expired or was never requested — request a new one", "EXPIRED_OR_NOT_FOUND");
  }

  const attempts = Number((await redis.get(attemptsKey)) ?? "0");
  if (attempts >= MAX_VERIFY_ATTEMPTS) {
    await redis.del(codeKey); // force a fresh request rather than allow further guessing
    throw new OtpError("Too many incorrect attempts — request a new code", "TOO_MANY_ATTEMPTS");
  }

  if (hashCode(code.trim()) !== storedHash) {
    await redis.incr(attemptsKey);
    throw new OtpError("Incorrect code", "INCORRECT");
  }

  // Correct — consume it immediately so it can't be replayed.
  await redis.del(codeKey);
  await redis.del(attemptsKey);
}
