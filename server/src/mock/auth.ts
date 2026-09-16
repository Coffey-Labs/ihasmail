import { account } from "./config.js";
import { parseOtpauthUrl, verifyTotp } from "../totp.js";

/* Shared by the HTTP layer and by the handlers that re-check a code. */
export function checkOtp(code: string | undefined): boolean {
  if (!account.otpUrl) return true;
  const params = parseOtpauthUrl(account.otpUrl);
  return Boolean(code && params && verifyTotp(params, code));
}
