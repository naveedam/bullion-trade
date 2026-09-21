/**
 * SMS Provider (OTP delivery)
 * ---------------------------------------------------------------------------
 * The OTP itself is generated and verified entirely by this platform (see
 * otp.ts - codes are hashed and stored in Redis, nothing delegated to a
 * vendor's own OTP verification service). This file's only job is
 * delivering that code to a phone number by SMS.
 *
 * NOT WIRED to a real vendor. After getting Kotak Neo's API wrong once
 * earlier in this build by guessing at an unverified endpoint, I'm not
 * repeating that here - especially not in the login path. Common choices
 * for an India-focused B2B app: MSG91, Twilio, TextLocal. Pick one, get an
 * API key, and implement sendOtpSms() below against their real docs.
 *
 * In development (NODE_ENV !== "production"), sendOtpSms() doesn't call
 * any vendor at all - it logs the code to the server console and the
 * request-otp API route echoes it back in the JSON response (clearly
 * marked, and ONLY when NODE_ENV !== "production" - see
 * src/app/api/auth/request-otp/route.ts) so the whole login flow is
 * testable locally without a real SMS account. That dev echo must never
 * ship to production; the route enforces this itself, not just this file.
 */

export class SmsProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmsProviderError";
  }
}

export interface SendSmsResult {
  delivered: boolean;
  /** Only ever populated outside production - see file header. */
  devEchoCode?: string;
}

export async function sendOtpSms(phone: string, code: string): Promise<SendSmsResult> {
  if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.log(`[sms:dev] OTP for ${phone}: ${code}`);
    return { delivered: true, devEchoCode: code };
  }

  // Real vendor call goes here. Example shape for MSG91's plain SMS send
  // (NOT verified against a real account - check MSG91's current docs
  // before using):
  //
  //   const response = await fetch("https://control.msg91.com/api/v5/flow/", {
  //     method: "POST",
  //     headers: { authkey: process.env.SMS_PROVIDER_API_KEY!, "Content-Type": "application/json" },
  //     body: JSON.stringify({
  //       template_id: process.env.SMS_OTP_TEMPLATE_ID,
  //       mobiles: phone.replace("+", ""),
  //       OTP: code,
  //     }),
  //   });
  //   if (!response.ok) throw new SmsProviderError(`SMS send failed: HTTP ${response.status}`);
  //   return { delivered: true };

  throw new SmsProviderError(
    "sendOtpSms is not wired to a real SMS vendor. Set one up (MSG91/Twilio/" +
      "TextLocal) and implement the request here - see this file's header " +
      "for an example shape. Currently only NODE_ENV=development is " +
      "supported (logs the code instead of sending it)."
  );
}
