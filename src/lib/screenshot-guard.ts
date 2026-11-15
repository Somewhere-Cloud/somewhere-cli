import type { Page } from '@playwright/test';
import { containsSecret } from './test-diagnostics.js';
import { mayShowSecret } from './form-auth.js';

// A failure screenshot is taken only of a page that cannot be showing a password, an emailed code,
// a reset link or a session (design slice 3a; Astra slice-3 check A6). Masking inputs is not enough:
// a custom form can show the code in an alert or a confirmation line. So no screenshot when:
//   - a sign-up, sign-in or verification step was on the page and did not finish,
//   - the address looks like a sign-in, sign-up, verification, code or reset page,
//   - a password or one-time-code field is visible, or
//   - any registered secret appears anywhere in the page's text or field values.
const AUTH_PATH = /(auth|log-?in|sign-?in|sign-?up|register|verif|reset|password|mfa|otp|code|magic|invite)/i;
const SECRET_FIELDS = 'input[type="password"], input[autocomplete="one-time-code"], [data-sw-auth="password"], [data-sw-auth="mfa-code"]';

export async function safeToScreenshot(page: Page): Promise<boolean> {
  if (page.isClosed() || mayShowSecret(page)) return false;
  try {
    if (AUTH_PATH.test(new URL(page.url()).pathname)) return false;
    const fields = page.locator(SECRET_FIELDS);
    const count = await fields.count();
    for (let i = 0; i < count; i++) if (await fields.nth(i).isVisible()) return false;
    const text = await page.evaluate<string>("[document.documentElement.innerText, ...Array.from(document.querySelectorAll('input, textarea')).map((el) => el.value)].join('\\n')");
    return !containsSecret(text);
  } catch { return false; }
}
