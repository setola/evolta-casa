// @vitest-environment jsdom
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

function styles() {
  const style = document.createElement('style');
  style.textContent = fs.readFileSync('src/styles.css', 'utf8');
  document.head.appendChild(style);
  return [...style.sheet!.cssRules];
}
function rule(rules: CSSRule[], selector: string) {
  const match = rules.find(entry => entry instanceof CSSStyleRule && entry.selectorText === selector) as CSSStyleRule | undefined;
  expect(match, selector).toBeDefined();
  return match!.style;
}
afterEach(() => document.head.querySelectorAll('style').forEach(style => style.remove()));

describe('hero a tutta altezza', () => {
  it('usa almeno un viewport senza altezze fisse che taglino i contenuti', () => {
    const rules = styles();
    for (const selector of ['.home-hero', '.future-step']) {
      const style = rule(rules, selector);
      expect(style.getPropertyValue('min-height')).toBe('100svh');
      expect(style.getPropertyValue('height')).toBe('');
      expect(style.getPropertyValue('box-sizing')).toBe('border-box');
      expect(style.getPropertyValue('overflow')).not.toBe('hidden');
      expect(style.getPropertyValue('background')).toContain('/ui/casa.png');
      expect(style.getPropertyValue('background')).toContain('cover');
    }
  });
  it('mantiene le card sullo sfondo fotografico usando il flusso per evitare sovrapposizioni', () => {
    const rules = styles();
    expect(rule(rules, '.home-hero').getPropertyValue('display')).toBe('grid');
    expect(rule(rules, '.future-step').getPropertyValue('display')).toBe('grid');
    for (const selector of ['.result-example', '.future-panel', '.future-summary', '.future-step .visual-footer']) {
      expect(rule(rules, selector).getPropertyValue('position')).toBe('relative');
    }
    expect(rule(rules, '.future-hero').getPropertyValue('background')).toBe('');
  });
  it('su mobile conserva il viewport e lo sfondo con card impilate e riepilogo leggibile', () => {
    const rules = styles();
    const mobile = rules.filter(entry => entry instanceof CSSMediaRule && entry.conditionText === '(max-width: 900px)') as CSSMediaRule[];
    const mobileRules = mobile.flatMap(entry => [...entry.cssRules]);
    expect(rule(mobileRules, '.future-step').getPropertyValue('min-height')).toBe('100svh');
    expect(rule(mobileRules, '.future-step').getPropertyValue('flex-direction')).toBe('column');
    expect(rule(mobileRules, '.future-step').getPropertyValue('background')).toBe('');
    expect(rule(mobileRules, '.home-hero').getPropertyValue('min-height')).toBe('');
    expect(rule(mobileRules, '.home-hero').getPropertyValue('background')).toContain('/ui/casa.png');
    expect(rule(mobileRules, '.result-example').getPropertyValue('grid-column')).toBe('1');
    // CSSOM serializers may express a zero length as either 0 or 0px.
    expect(rule(mobileRules, '.future-summary').getPropertyValue('grid-template-columns')).toMatch(/^minmax\(0(?:px)?, 1fr\)$/);
  });
});
