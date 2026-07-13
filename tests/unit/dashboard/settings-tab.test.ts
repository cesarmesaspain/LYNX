import { describe, expect, it } from 'vitest';
import { settingsTabScript } from '../../../src/server/dashboard/scripts/settings-tab.js';

describe('settings secret hydration', () => {
  it('shows configured secret keys as placeholders without placing masked values in fields', () => {
    const script = settingsTabScript(false, {
      save: 'Save', saved: 'Saved', saving: 'Saving...', loaded: '(configured)', agentResponseSaved: 'Preference saved',
    });

    expect(script).toContain('d.value="";d.placeholder="(configured)"');
    expect(script).toContain('p.value="";p.placeholder="(configured)"');
    expect(script).not.toContain('d.value=k.deepseek');
    expect(script).not.toContain('p.value=k.vps_key');
    expect(script).toContain('cfgMcpToolProfile');
  });
});
