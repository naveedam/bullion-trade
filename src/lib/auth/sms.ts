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
 * Two ways the dev-echo (log instead of send) path activates:
 *   1. NODE_ENV !== "production" - normal local development.
 *   2. ALLOW_SMS_DEV_ECHO=true - an explicit, deliberate override for
 *      testing a real deployment (e.g. Vercel, where NODE_ENV is always
 *      "production") before a real SMS vendor is wired. This is NOT tied
 *      to environment detection on purpose - it only activates if you set
 *      it yourself, so it can never accidentally leak into a real
 *      customer-facing deployment. Unset it (or set it to anything other
 *      than "true") once a real vendor is wired below, since leaving it on
 *      means anyone's OTP is visible in the API response.
 *
 * Either way, the request-otp API route only echoes the code back in the
 * JSON response when one of these two conditions holds - see
 * src/app/api/auth/request-otp/route.ts.
 */

export class SmsProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmsProviderError";
  }
}

export interface SendSmsResult {
  delivered: boolean;
  /** Only populated when the dev-echo path is active - see file header. */
  devEchoCode?: string;
}

function devEchoActive(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.ALLOW_SMS_DEV_ECHO === "true";
}

export async function sendOtpSms(phone: string, code: string): Promise<SendSmsResult> {
  if (devEchoActive()) {
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
      "for an example shape. Or set ALLOW_SMS_DEV_ECHO=true to keep testing " +
      "without one for now."
  );
}
