import { describe, expect, it } from 'vitest';
import { mainInitScript } from '../../../src/server/dashboard/scripts/main-init.js';

describe('mainInitScript locale control', () => {
  it('persists the selected locale and reloads only after success', () => {
    const script = mainInitScript(false, [], '', {}, null);

    expect(script).toContain("document.getElementById('localeSelect')");
    expect(script).toContain("fetch('/api/locale?locale=' + encodeURIComponent(locale), { method: 'POST' })");
    expect(script).toContain('if (!response.ok) throw new Error');
    expect(script).toContain('location.reload();');
  });
});
