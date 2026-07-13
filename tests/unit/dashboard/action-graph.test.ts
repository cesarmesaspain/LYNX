import { describe, expect, it } from 'vitest';
import { actionGraphScript } from '../../../src/server/dashboard/scripts/action-graph.js';

describe('actionGraphScript', () => {
  it('pauses the animation loop when the dashboard is hidden', () => {
    const script = actionGraphScript();

    expect(script).toContain("document.visibilityState !== 'visible'");
    expect(script).toContain("document.addEventListener('visibilitychange'");
    expect(script).toContain('animationFrame = null;');
  });

  it('honours the reduced-motion preference', () => {
    const script = actionGraphScript();

    expect(script).toContain("prefers-reduced-motion: reduce");
    expect(script).toContain('if (reduceMotion || document.visibilityState');
  });

  it('keeps generated brief metadata in the selected language', () => {
    const script = actionGraphScript();

    expect(script).toContain("isSpanish ? 'generado ' : 'generated '");
    expect(script).toContain("isSpanish ? 'en caché' : 'cached'");
  });
  it('indexes graph nodes once per force step', () => {
    const script = actionGraphScript();

    expect(script).toContain(
      'const nodesById = new Map(nodes.map(node => [node.id, node]));',
    );
    expect(script).toContain(
      'const a = nodesById.get(e.source), b = nodesById.get(e.target);',
    );
    expect(script).not.toContain('const neighbors = new Map();');
    expect(script).not.toContain('nodes.find(nd => nd.id === e.source)');
  });

});
