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
    expect(html).toContain('>Sessions</div>');
    expect(html).toContain('>Tasks</div>');
    expect(html).toContain('>Estimated LLM cost</div>');
    expect(html).not.toContain('Measured estimated cost');
    expect(html).toContain('id="mtSessions"');
    expect(html).toContain('id="mtTasks"');
    expect(html).toContain('Measured impact and efficiency');
    expect(html).toContain('Activity breakdown');
    expect(html).toContain('id="exportMetricsCsv"');
    expect(html).toContain('>Download CSV</a>');
    expect(html).toContain('> Add project</button>');
    expect(html).not.toContain('LOCAL CODE INTELLIGENCE');
    expect(html).not.toContain('> Proyecto</button>');
    expect(html).not.toContain('title="Pantalla completa"');
  });
});
