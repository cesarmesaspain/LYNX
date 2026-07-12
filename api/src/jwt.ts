/*
 * jwt.ts — JWT signing and verification for LYNX licenses.
 *
 * Uses RS256 asymmetric keys:
 *   - Private key: only on the API server (signs new licenses)
 *   - Public key: embedded in every LYNX binary (offline validation)
 *
 * Key generation on first run if no keys exist:
 *   ssh-keygen -t rsa -b 2048 -m PEM -f data/license_private.pem
 *   ssh-keygen -f data/license_private.pem -e -m PKCS8 > data/license_public.pem
 */

import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const DATA_DIR = process.env.LYNX_API_DATA_DIR || path.resolve(import.meta.dirname, '../data');
const PRIVATE_KEY_PATH = path.join(DATA_DIR, 'license_private.pem');
const PUBLIC_KEY_PATH = path.join(DATA_DIR, 'license_public.pem');

function generateKeys(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  execSync(
    `ssh-keygen -t rsa -b 2048 -m PEM -N "" -f "${PRIVATE_KEY_PATH}"`,
    { stdio: 'pipe' }
  );
  const pubKey = execSync(
    `ssh-keygen -f "${PRIVATE_KEY_PATH}" -e -m PKCS8`,
    { encoding: 'utf-8', stdio: 'pipe' }
  );
  fs.writeFileSync(PUBLIC_KEY_PATH, pubKey);
}

function getPrivateKey(): string {
  const configured = process.env.LYNX_LICENSE_PRIVATE_KEY;
  if (configured) return configured.replace(/\\n/g, '\n');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('LYNX_LICENSE_PRIVATE_KEY must be configured in production');
  }
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    generateKeys();
  }
  return fs.readFileSync(PRIVATE_KEY_PATH, 'utf-8');
}

function getPublicKey(): string {
  const configured = process.env.LYNX_LICENSE_PUBLIC_KEY;
  if (configured) return configured.replace(/\\n/g, '\n');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('LYNX_LICENSE_PUBLIC_KEY must be configured in production');
  }
  if (!fs.existsSync(PUBLIC_KEY_PATH)) {
    generateKeys();
  }
  return fs.readFileSync(PUBLIC_KEY_PATH, 'utf-8');
}

export interface LicensePayload {
  sub: string;        // user id
  email: string;
  tier: 'free' | 'pro' | 'team' | 'enterprise';
  iat: number;
  exp: number;
  machines: string[]; // machine fingerprints
}

export function signLicense(payload: Omit<LicensePayload, 'iat' | 'exp'>): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { ...payload, iat: now, exp: now + 30 * 24 * 3600 }, // 30 days
    getPrivateKey(),
    { algorithm: 'RS256' }
  );
}

export function verifyLicense(token: string): LicensePayload | null {
  try {
    const decoded = jwt.verify(token, getPublicKey(), { algorithms: ['RS256'] });
    return decoded as LicensePayload;
  } catch {
    return null;
  }
}

export function getPublicKeyPem(): string {
  return getPublicKey();
}

export function signLicenseWithExpiry(
  payload: Omit<LicensePayload, 'iat' | 'exp'>,
  expiresInDays: number
): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { ...payload, iat: now, exp: now + expiresInDays * 24 * 3600 },
    getPrivateKey(),
    { algorithm: 'RS256' }
  );
}
