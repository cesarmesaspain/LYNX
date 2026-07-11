import { describe, expect, it } from 'vitest';
import {
  projectNotIndexed,
  projectStale,
  projectLocked,
  projectFailed,
  gitRequired,
  noResults,
} from '../../../src/mcp/diagnostics.js';

describe('diagnostics', () => {
  describe('projectNotIndexed', () => {
    it('returns error with project name', () => {
      const d = projectNotIndexed('my-app');
      expect(d.error).toContain('my-app');
      expect(d.error).toContain('not indexed');
      expect(d.hint).toContain('index_repository');
      expect(d.recoverable).toBe(true);
    });
  });

  describe('projectStale', () => {
    it('returns error with hours', () => {
      const d = projectStale('my-app', 48);
      expect(d.error).toContain('my-app');
      expect(d.error).toContain('48h');
      expect(d.hint).toContain('mode=fast');
      expect(d.recoverable).toBe(true);
    });
  });

  describe('projectLocked', () => {
    it('returns error with reason', () => {
      const d = projectLocked('my-app', 'pid 12345 is already indexing');
      expect(d.error).toContain('my-app');
      expect(d.error).toContain('pid 12345');
      expect(d.hint).toContain('force_lock=true');
      expect(d.recoverable).toBe(true);
    });
  });

  describe('projectFailed', () => {
    it('returns error with failure message', () => {
      const d = projectFailed('my-app', 'ENOENT: no such file');
      expect(d.error).toContain('my-app');
      expect(d.error).toContain('ENOENT');
      expect(d.hint).toContain('Re-run');
      expect(d.recoverable).toBe(true);
    });
  });

  describe('gitRequired', () => {
    it('returns non-recoverable error', () => {
      const d = gitRequired('my-app');
      expect(d.error).toContain('my-app');
      expect(d.error).toContain('git');
      expect(d.hint).toContain('Initialize git');
      expect(d.recoverable).toBe(false);
    });
  });

  describe('noResults', () => {
    it('returns error with query', () => {
      const d = noResults('login handler');
      expect(d.error).toContain('login handler');
      expect(d.hint).toContain('name_pattern');
      expect(d.recoverable).toBe(true);
    });

    it('includes kind when provided', () => {
      const d = noResults('login', 'function');
      expect(d.error).toContain('functions');
      expect(d.error).toContain('login');
    });
  });

  describe('Diagnostics contract', () => {
    it('every diagnostic has error, hint, recoverable', () => {
      const all = [
        projectNotIndexed('p'),
        projectStale('p', 24),
        projectLocked('p', 'reason'),
        projectFailed('p', 'err'),
        gitRequired('p'),
        noResults('q'),
        noResults('q', 'function'),
      ];
      for (const d of all) {
        expect(d).toHaveProperty('error');
        expect(typeof d.error).toBe('string');
        expect(d.error.length).toBeGreaterThan(0);
        expect(d).toHaveProperty('hint');
        expect(typeof d.hint).toBe('string');
        expect(d.hint!.length).toBeGreaterThan(0);
        expect(d).toHaveProperty('recoverable');
        expect(typeof d.recoverable).toBe('boolean');
      }
    });
  });
});
