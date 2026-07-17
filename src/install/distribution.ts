import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DistributionInstallRequest {
  artifactPath: string;
  destinationPath: string;
  expectedSha256: string;
  version: string;
  accept: (installedPath: string) => Promise<void>;
}

export interface DistributionReceipt {
  type: 'lynx.distribution.install.v1';
  version: string;
  destinationPath: string;
  previousPath: string | null;
  sha256: string;
}

export interface DistributionFileOps {
  exists(filePath: string): boolean;
  rename(from: string, to: string): void;
}

const defaultDistributionFileOps: DistributionFileOps = {
  exists: filePath => fs.existsSync(filePath),
  rename: (from, to) => fs.renameSync(from, to),
};

export function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function assertSha256(expected: string, actual: string): void {
  const normalized = expected.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error('Distribution manifest contains an invalid SHA-256 digest.');
  }
  const matches = crypto.timingSafeEqual(Buffer.from(normalized), Buffer.from(actual));
  if (!matches) throw new Error(`Distribution checksum mismatch: expected ${normalized}, got ${actual}.`);
}

function uniqueSibling(destinationPath: string, label: string): string {
  return `${destinationPath}.${label}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
}

function removeIfPresent(filePath: string): void {
  try { fs.rmSync(filePath, { force: true }); } catch { /* best effort cleanup */ }
}

/**
 * Install one already-downloaded artifact as a filesystem transaction.
 *
 * Download and release-manifest retrieval deliberately live outside this
 * boundary. This owner verifies the artifact, stages it beside the destination
 * so the publish rename stays on one filesystem, retains exactly one accepted
 * previous version, and restores that version if post-install acceptance fails.
 */
export async function installDistributionArtifact(
  request: DistributionInstallRequest,
): Promise<DistributionReceipt> {
  const destination = path.resolve(request.destinationPath);
  const source = path.resolve(request.artifactPath);
  if (source === destination) throw new Error('Distribution artifact and destination must differ.');
  if (!fs.statSync(source).isFile()) throw new Error(`Distribution artifact is not a file: ${source}`);

  const digest = sha256File(source);
  assertSha256(request.expectedSha256, digest);

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const stage = uniqueSibling(destination, 'stage');
  const displaced = uniqueSibling(destination, 'displaced');
  const previous = `${destination}.previous`;
  const hadCurrent = fs.existsSync(destination);
  let currentDisplaced = false;
  let stagePublished = false;

  try {
    fs.copyFileSync(source, stage, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(stage, 0o755);
    assertSha256(request.expectedSha256, sha256File(stage));

    if (hadCurrent) {
      fs.renameSync(destination, displaced);
      currentDisplaced = true;
    }
    fs.renameSync(stage, destination);
    stagePublished = true;

    await request.accept(destination);

    removeIfPresent(previous);
    if (currentDisplaced) fs.renameSync(displaced, previous);
    return {
      type: 'lynx.distribution.install.v1',
      version: request.version,
      destinationPath: destination,
      previousPath: currentDisplaced ? previous : null,
      sha256: digest,
    };
  } catch (error) {
    if (stagePublished) removeIfPresent(destination);
    if (currentDisplaced && fs.existsSync(displaced)) fs.renameSync(displaced, destination);
    throw error;
  } finally {
    removeIfPresent(stage);
    removeIfPresent(displaced);
  }
}

/** Restore the last accepted artifact while retaining the replaced build. */
export async function rollbackDistribution(
  destinationPath: string,
  accept: (installedPath: string) => Promise<void>,
  fileOps: DistributionFileOps = defaultDistributionFileOps,
): Promise<void> {
  const destination = path.resolve(destinationPath);
  const previous = `${destination}.previous`;
  if (!fileOps.exists(previous)) throw new Error(`No previous LYNX distribution is available for ${destination}.`);

  const displaced = uniqueSibling(destination, 'rollback');
  const hadCurrent = fileOps.exists(destination);
  let displacedExists = false;
  if (hadCurrent) {
    fileOps.rename(destination, displaced);
    displacedExists = true;
  }
  try {
    fileOps.rename(previous, destination);
  } catch (error) {
    if (displacedExists && fileOps.exists(displaced)) {
      fileOps.rename(displaced, destination);
      displacedExists = false;
    }
    throw error;
  }

  try {
    try {
      await accept(destination);
    } catch (error) {
      fileOps.rename(destination, previous);
      if (displacedExists && fileOps.exists(displaced)) {
        fileOps.rename(displaced, destination);
        displacedExists = false;
      }
      throw error;
    }
    if (displacedExists) {
      fileOps.rename(displaced, previous);
      displacedExists = false;
    }
  } catch (error) {
    // Never remove `displaced` here. If a filesystem operation failed it may
    // be the only recoverable copy of the pre-rollback distribution. Leaving
    // an explicitly named recovery artifact is safer than destructive cleanup.
    throw error;
  }
}
