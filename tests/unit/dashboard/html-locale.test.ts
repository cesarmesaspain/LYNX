import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/config/runtime.js', () => ({
  readLynxConfig: () => ({ locale: 'en' }),
}));

import { renderDashboard } from '../../../src/server/dashboard/html.js';

describe('dashboard locale contract', () => {
  it('keeps graph and project controls in English when English is selected', () => {
    const html = renderDashboard([]);

    expect(html).toContain('> Add project</button>');
    expect(html).toContain('title="Fullscreen"');
    expect(html).toContain('aria-label="Fullscreen graph controls"');
    expect(html).toContain('aria-label="Previous"');
    expect(html).toContain('>Architecture Brief</h2>');
    expect(html).toContain('>Force</button>');
    expect(html).toContain('id="cfgBriefLlm"');
    expect(html).toContain('id="cfgMcpToolProfile"');
    expect(html).toContain('> Add project</button>');
    expect(html).not.toContain('LOCAL CODE INTELLIGENCE');
    expect(html).not.toContain('> Proyecto</button>');
    expect(html).not.toContain('title="Pantalla completa"');
  });
});
