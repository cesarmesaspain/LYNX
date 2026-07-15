import { licensesDb } from './db.js';
import { verifyLicense, type LicensePayload } from './jwt.js';

export type LicenseAccess =
  | { license: LicensePayload; reason: null }
  | { license: null; reason: 'invalid_license' | 'inactive_license' };

/** Resolves a signed credential against the current billing entitlement. */
export function resolveLicenseAccess(token: string): LicenseAccess {
  const signed = verifyLicense(token);
  if (!signed) return { license: null, reason: 'invalid_license' };

  const user = licensesDb.prepare(
    'SELECT tier, billing_status FROM users WHERE id = ?'
  ).get(signed.sub) as { tier: LicensePayload['tier']; billing_status: string | null } | undefined;

  if (!user || user.billing_status !== 'active') {
    return { license: null, reason: 'inactive_license' };
  }

  return { license: { ...signed, tier: user.tier }, reason: null };
}
