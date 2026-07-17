import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installDistributionArtifact,
  rollbackDistribution,
  sha256File,
} from '../../../src/install/distribution.js';

const roots: string[] = [];

function fixture(): { root: string; artifact: string; destination: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-distribution-'));
  roots.push(root);
  return {
    root,
    artifact: path.join(root, 'downloaded-lynx'),
    destination: path.join(root, 'bin', 'lynx'),
  };
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('distribution lifecycle transaction', () => {
  it('rejects an untrusted artifact before changing the installed binary', async () => {
    const { artifact, destination } = fixture();
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(artifact, 'compromised');
    fs.writeFileSync(destination, 'v1');

    await expect(installDistributionArtifact({
      artifactPath: artifact,
      destinationPath: destination,
      expectedSha256: digest('v2'),
      version: 'v2',
      accept: async () => undefined,
    })).rejects.toThrow('checksum mismatch');

    expect(fs.readFileSync(destination, 'utf8')).toBe('v1');
    expect(fs.existsSync(`${destination}.previous`)).toBe(false);
  });

  it('publishes atomically and retains the last accepted artifact', async () => {
    const { artifact, destination } = fixture();
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(artifact, 'v2');
    fs.writeFileSync(destination, 'v1');

    const receipt = await installDistributionArtifact({
      artifactPath: artifact,
      destinationPath: destination,
      expectedSha256: sha256File(artifact),
      version: 'v2',
      accept: async installed => expect(fs.readFileSync(installed, 'utf8')).toBe('v2'),
    });

    expect(receipt.previousPath).toBe(`${destination}.previous`);
    expect(fs.readFileSync(destination, 'utf8')).toBe('v2');
    expect(fs.readFileSync(`${destination}.previous`, 'utf8')).toBe('v1');
  });

  it('restores the current artifact when post-install acceptance fails', async () => {
    const { artifact, destination } = fixture();
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(artifact, 'broken-v2');
    fs.writeFileSync(destination, 'v1');

    await expect(installDistributionArtifact({
      artifactPath: artifact,
      destinationPath: destination,
      expectedSha256: sha256File(artifact),
      version: 'v2',
      accept: async () => { throw new Error('MCP acceptance failed'); },
    })).rejects.toThrow('MCP acceptance failed');

    expect(fs.readFileSync(destination, 'utf8')).toBe('v1');
    expect(fs.readdirSync(path.dirname(destination)).sort()).toEqual(['lynx']);
  });

  it('rolls back and keeps the replaced build available for recovery', async () => {
    const { artifact, destination } = fixture();
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(artifact, 'v2');
    fs.writeFileSync(destination, 'v1');
    await installDistributionArtifact({
      artifactPath: artifact,
      destinationPath: destination,
      expectedSha256: sha256File(artifact),
      version: 'v2',
      accept: async () => undefined,
    });

    await rollbackDistribution(destination, async installed => {
      expect(fs.readFileSync(installed, 'utf8')).toBe('v1');
    });

    expect(fs.readFileSync(destination, 'utf8')).toBe('v1');
    expect(fs.readFileSync(`${destination}.previous`, 'utf8')).toBe('v2');
  });
});
