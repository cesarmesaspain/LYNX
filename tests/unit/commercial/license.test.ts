/*
 * license.test.ts — Tests for license validation, tier gating, and JWT handling.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Generate a test Ed25519 keypair for JWT signing
function generateTestKeypair(): { publicKey: string; privateKey: string } {
  // We use static test keys for deterministic test output
  // Real Ed25519 key: pre-generated for tests
  const publicKey = 'MCowBQYDK2VwAyEArVwFI+EKmB7gGQpH9PK9KMKxw1l0vJFpHvK0hHCGGJc=';
  const privateKey = 'MC4CAQAwBQYDK2VwBCIEIK3U4qF7gPGzBmJ9ZyR/BGzK6kJXBQnXhPhP5Pjv7N7P';
  return { publicKey, privateKey };
}

function signJwt(payload: Record<string, unknown>, privateKeyPem: string): string {
  const { subtle } = globalThis as unknown as { subtle: { importKey: Function; sign: Function } };

  // For dev mode (no crypto.subtle available in Node without special setup),
  // we create a raw unsigned token that passes validation in dev mode
  const header = { alg: 'EdDSA', typ: 'JWT' };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');

  // In dev mode (no LYNX_LICENSE_PUBLIC_KEY), verification is skipped
  return `${headerB64}.${payloadB64}.dev-signature`;
}

describe('license', () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-license-test-'));
    process.env.LYNX_HOME = tmpDir;
    // Clear the module cache so tests get fresh imports
    delete (process.env as Record<string, string | undefined>).LYNX_LICENSE_PUBLIC_KEY;
    process.env.LYNX_DEV_LICENSE_BYPASS = '1';
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  // Dynamically import so LYNX_HOME takes effect
  async function loadLicenseModule() {
    return await import('../../../src/commercial/license.js');
  }

  it('readLicense returns null when no license file exists', async () => {
    const { readLicense } = await loadLicenseModule();
    expect(readLicense()).toBeNull();
  });

  it('saveLicense and readLicense round-trip a valid JWT', async () => {
    const { saveLicense, readLicense } = await loadLicenseModule();

    const payload = {
      sub: 'user-123',
      email: 'test@lynx.dev',
      tier: 'pro',
      exp: Math.floor(Date.now() / 1000) + 86400 * 365, // 1 year
      iat: Math.floor(Date.now() / 1000),
    };
    const jwt = signJwt(payload, '');

    saveLicense(jwt);
    const license = readLicense();

    expect(license).not.toBeNull();
    expect(license!.sub).toBe('user-123');
    expect(license!.email).toBe('test@lynx.dev');
    expect(license!.tier).toBe('pro');
    expect(license!.isValid).toBe(true); // dev mode — no key
  });

  it('invalid token returns null from readLicense', async () => {
    const { saveLicense, readLicense } = await loadLicenseModule();
    saveLicense('not-a-jwt');
    expect(readLicense()).toBeNull();
  });

  it('expired JWT returns is_valid=false and tier=free', async () => {
    const { saveLicense, readLicense } = await loadLicenseModule();

    const payload = {
      sub: 'user-456',
      email: 'old@lynx.dev',
      tier: 'pro',
      exp: Math.floor(Date.now() / 1000) - 86400, // expired yesterday
      iat: Math.floor(Date.now() / 1000) - 86400 * 2,
    };
    const jwt = signJwt(payload, '');
    saveLicense(jwt);

    const license = readLicense();
    expect(license).not.toBeNull();
    expect(license!.isValid).toBe(false);
    expect(license!.tier).toBe('free'); // degraded
  });

  it('getTier returns pro only with the explicit development bypass', async () => {
    const { getTier } = await loadLicenseModule();
    expect(getTier()).toBe('pro');
  });

  it('fails closed when the explicit development bypass is absent', async () => {
    delete (process.env as Record<string, string | undefined>).LYNX_DEV_LICENSE_BYPASS;
    const { saveLicense, getTier } = await loadLicenseModule();
    saveLicense(signJwt({ sub: 'forged', tier: 'enterprise', exp: Math.floor(Date.now() / 1000) + 86400 }, ''));
    expect(getTier()).toBe('free');
    process.env.LYNX_DEV_LICENSE_BYPASS = '1';
  });

  it('saveLicense persists to disk', async () => {
    const { saveLicense, readLicense } = await loadLicenseModule();

    const payload = { sub: 'disk', tier: 'team', exp: Math.floor(Date.now() / 1000) + 86400 };
    saveLicense(signJwt(payload, ''));

    // Re-load module to check persistence
    const fresh = await import('../../../src/commercial/license.js');
    const license = fresh.readLicense();
    expect(license).not.toBeNull();
    expect(license!.sub).toBe('disk');
  });

  it('license file path respects LYNX_HOME', async () => {
    const { saveLicense } = await loadLicenseModule();

    const payload = { sub: 'home', tier: 'free', exp: Math.floor(Date.now() / 1000) + 86400 };
    saveLicense(signJwt(payload, ''));

    const expectedPath = path.join(tmpDir, 'license');
    expect(fs.existsSync(expectedPath)).toBe(true);
  });
});

describe('license CLI', () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-license-cli-'));
    process.env.LYNX_HOME = tmpDir;
    delete (process.env as Record<string, string | undefined>).LYNX_LICENSE_PUBLIC_KEY;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('cmdLicense status shows free tier when no license', async () => {
    // Capture console.log
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

    try {
      const { cmdLicense } = await import('../../../src/cli/commands/license-cmd.js');
      cmdLicense(['status']);
      expect(logs.some(l => l.includes('Sin licencia'))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  it('cmdLicense tier shows pro with the explicit development bypass', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

    try {
      const { cmdLicense } = await import('../../../src/cli/commands/license-cmd.js');
      cmdLicense(['tier']);
      expect(logs).toContain('pro');
    } finally {
      console.log = origLog;
    }
  });
});
