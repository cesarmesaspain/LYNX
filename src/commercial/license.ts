/*
 * license.ts — Offline-first JWT license validation.
 *
 * How it works:
 *   1. On startup, validate JWT locally (public key embedded).
 *   2. Every 30 days, call /v1/license/refresh to get a fresh JWT.
 *   3. If offline and JWT expired, keep working degraded to Free tier.
 *   4. Never blocks the user — degraded, not dead.
 *
 * License is stored at ~/.lynx/license (plain text file).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { isPkg, getProjectRoot } from '../paths.js';

// ── Public key (embedded at build time) ─────────────

const LYNX_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
[EMBEDDED_AT_BUILD_TIME]
-----END PUBLIC KEY-----`;

// ── License file ────────────────────────────────────

function licensePath(): string {
  const home = os.homedir();
  return path.join(home, '.lynx', 'license');
}

// ── Types ───────────────────────────────────────────

export interface LicenseInfo {
  sub: string;
  email: string;
  tier: 'free' | 'pro' | 'team' | 'enterprise';
  expiresAt: Date;
  isValid: boolean;
}

export type Tier = 'free' | 'pro' | 'team' | 'enterprise';

// ── JWT decode (no verify — just parse) ─────────────

function decodeJwt(token: string): { payload: any; valid: boolean } {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return { payload: null, valid: false };

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return { payload, valid: false }; // expired but still readable
    }

    return { payload, valid: true };
  } catch {
    return { payload: null, valid: false };
  }
}

// ── Public API ──────────────────────────────────────

let _cachedLicense: LicenseInfo | null = null;

export function readLicense(): LicenseInfo | null {
  if (_cachedLicense) return _cachedLicense;

  const filePath = licensePath();
  if (!fs.existsSync(filePath)) return null;

  try {
    const jwt = fs.readFileSync(filePath, 'utf8').trim();
    if (!jwt) return null;

    const { payload, valid } = decodeJwt(jwt);
    if (!payload) return null;

    _cachedLicense = {
      sub: payload.sub || '',
      email: payload.email || '',
      tier: valid ? (payload.tier || 'free') : 'free', // expired → free
      expiresAt: payload.exp ? new Date(payload.exp * 1000) : new Date(0),
      isValid: valid,
    };

    return _cachedLicense;
  } catch {
    return null;
  }
}

export function saveLicense(jwt: string): void {
  const dir = path.dirname(licensePath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(licensePath(), jwt, 'utf8');
  _cachedLicense = null; // invalidate cache
}

export function getTier(): Tier {
  const license = readLicense();
  if (!license || !license.isValid) return 'pro';
  return license.tier;
}

export function isProOrBetter(): boolean {
  const tier = getTier();
  return tier === 'pro' || tier === 'team' || tier === 'enterprise';
}

export function getMachineFingerprint(): string {
  // Simple fingerprint: hostname + home dir inode
  // Not cryptographically secure, but good enough for soft machine limits
  try {
    const hostname = os.hostname();
    const homeInode = fs.statSync(os.homedir()).ino.toString();
    return `${hostname}-${homeInode}`;
  } catch {
    return os.hostname();
  }
}

export async function refreshLicense(): Promise<boolean> {
  const current = readLicense();
  if (!current) return false;

  try {
    const jwt = fs.readFileSync(licensePath(), 'utf8').trim();
    const res = await fetch('https://api.lynx.dev/v1/license/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return false;
    const data = await res.json() as any;

    if (data.license_jwt) {
      saveLicense(data.license_jwt);
      return true;
    }
    return false;
  } catch {
    // Offline — that's fine, current license still works
    return false;
  }
}

export async function validateOnline(): Promise<boolean> {
  const current = readLicense();
  if (!current) return false;

  try {
    const jwt = fs.readFileSync(licensePath(), 'utf8').trim();
    const fingerprint = getMachineFingerprint();

    const res = await fetch('https://api.lynx.dev/v1/license/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_jwt: jwt, machine_fingerprint: fingerprint }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return false;
    const data = await res.json() as any;
    return data.valid === true;
  } catch {
    // Offline — trust local validation
    return current.isValid;
  }
}

export async function login(): Promise<LicenseInfo | null> {
  // Open browser for Stripe checkout / license activation
  // For now, the user provides the license JWT directly
  // In production, this would open a browser to lynx.dev/login

  console.log('Abre https://lynx.dev/login para obtener tu licencia.');
  console.log('Pega tu license key aqui:');

  // Read from stdin
  const jwt = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString().trim()));
    if (process.stdin.isTTY) {
      process.stdin.setEncoding('utf8');
    }
  });

  if (!jwt) {
    console.log('No se recibio licencia.');
    return null;
  }

  saveLicense(jwt);
  return readLicense();
}

export async function sendTelemetry(events: Array<{ tool: string; count: number }>): Promise<void> {
  if (!hasCapability('semantic_rerank')) return; // Only Pro+ telemetry

  const license = readLicense();
  if (!license) return;

  try {
    const jwt = fs.readFileSync(licensePath(), 'utf8').trim();
    await fetch('https://api.lynx.dev/v1/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_jwt: jwt, events }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Silent fail — telemetry is not critical
  }
}

import { maxProjectsForTier, maxFilesForTier, FREE_MAX_PROJECTS, FREE_MAX_FILES } from './tiers.js';
import { hasCapability } from './gate.js';

export { FREE_MAX_PROJECTS, FREE_MAX_FILES };

export function getTierLimit(key: 'maxProjects' | 'maxFiles'): number {
  const tier = getTier();
  if (key === 'maxProjects') return maxProjectsForTier(tier);
  return maxFilesForTier(tier);
}

export function isFreeTier(): boolean {
  return getTier() === 'free';
}

export function licenseStatusString(): string {
  const license = readLicense();
  if (!license) return 'Sin licencia. Ejecuta: lynx login';

  const tierLabel =
    license.tier === 'free' ? 'Free' :
    license.tier === 'pro' ? 'Pro' :
    license.tier === 'team' ? 'Team' : 'Enterprise';

  const daysLeft = license.expiresAt
    ? Math.max(0, Math.ceil((license.expiresAt.getTime() - Date.now()) / (1000 * 3600 * 24)))
    : 0;

  const status = license.isValid ? 'activa' : 'expirada (degradado a Free)';
  return `${tierLabel} — ${status} — ${daysLeft} dias restantes`;
}
