import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import fs from 'node:fs';
import { AppConfigSchema } from '../configSchema';
import { autoLayoutPlane, defaultRoofPlane, packPanels, panelFootprint, pointInPolygon, roofAlignmentAngle } from './roof';
import type { Point, RoofPlane } from '../types';

const config = AppConfigSchema.parse(YAML.parse(fs.readFileSync('public/config/assumptions.yaml', 'utf8')));

function rectanglePlane(pitchDeg = 30): RoofPlane {
  return { ...defaultRoofPlane(), pitchDeg, polygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 0, y: 6 }], areaM2: 60 };
}

function rotate(point: Point, angle: number): Point {
  return { x: point.x * Math.cos(angle) - point.y * Math.sin(angle), y: point.x * Math.sin(angle) + point.y * Math.cos(angle) };
}

// Separating-axis test: touching edges are not positive-area overlaps.
function overlaps(a: Point[], b: Point[]): boolean {
  return [...a, ...b].every((point, index) => {
    const next = index < a.length ? a[(index + 1) % a.length] : b[(index - a.length + 1) % b.length];
    const axis = { x: -(next.y - point.y), y: next.x - point.x };
    const project = (polygon: Point[]) => polygon.map(p => p.x * axis.x + p.y * axis.y);
    const ap = project(a), bp = project(b);
    return Math.min(Math.max(...ap), Math.max(...bp)) - Math.max(Math.min(...ap), Math.min(...bp)) > 1e-8;
  });
}

function expectValidLayout(plane: RoofPlane) {
  const footprints = plane.panels.map(panel => panelFootprint(plane, panel, config));
  for (const [index, footprint] of footprints.entries()) {
    expect(footprint).toHaveLength(4);
    for (const corner of footprint) expect(pointInPolygon(corner, plane.polygon)).toBe(true);
    for (const other of footprints.slice(index + 1)) expect(overlaps(footprint, other)).toBe(false);
    for (const obstacle of plane.obstacles ?? []) expect(overlaps(footprint, obstacle.polygon)).toBe(false);
  }
}

describe('proiezione della falda', () => {
  it.each(['portrait', 'landscape'] as const)('aumenta la capienza a 30°: %s', (orientation) => {
    const plane = rectanglePlane();
    expect(packPanels(plane, config, orientation).length).toBeGreaterThan(
      packPanels({ ...plane, pitchDeg: 0 }, config, orientation).length,
    );
  });
});

describe('footprint e layout automatico', () => {
  it.each(['portrait', 'landscape'] as const)('proietta dimensioni fisiche e centri in pianta: %s', (layoutOrientation) => {
    for (const pitchDeg of [0, 30]) {
      const plane = { ...rectanglePlane(pitchDeg), layoutOrientation };
      const panels = packPanels(plane, config);
      expect(panels).toHaveLength(layoutOrientation === 'portrait' ? (pitchDeg ? 21 : 14) : (pitchDeg ? 25 : 20));
      const corners = panelFootprint(plane, panels[0], config);
      const width = layoutOrientation === 'portrait' ? 1.13 : 1.76;
      const height = layoutOrientation === 'portrait' ? 1.76 : 1.13;
      expect(corners[1].x - corners[0].x).toBeCloseTo(width);
      expect(corners[3].y - corners[0].y).toBeCloseTo(height * Math.cos(pitchDeg * Math.PI / 180));
      expect((corners[0].y + corners[2].y) / 2).toBeCloseTo(panels[0].position.y);
      expect(corners[0].y).toBeCloseTo(0.35 * Math.cos(pitchDeg * Math.PI / 180));
      expectValidLayout({ ...plane, panels });
    }
  });

  it.each(['portrait', 'landscape'] as const)('mantiene geometria e ostacoli su tetto ruotato: %s', (layoutOrientation) => {
    const angle = 0.61;
    const base = { ...rectanglePlane(), layoutOrientation };
    const first = packPanels(base, config)[0].position;
    const obstacle = [{ x: first.x - 0.1, y: first.y - 0.1 }, { x: first.x + 0.1, y: first.y - 0.1 }, { x: first.x + 0.1, y: first.y + 0.1 }, { x: first.x - 0.1, y: first.y + 0.1 }];
    const plane = { ...base, polygon: base.polygon.map(p => rotate(p, angle)), obstacles: [{ id: 'chimney', label: 'Camino', mapPolygon: [], polygon: obstacle.map(p => rotate(p, angle)) }] };
    const panels = packPanels(plane, config);
    expect(panels).toHaveLength(packPanels(base, config).length - 1);
    expect(roofAlignmentAngle(plane)).toBeCloseTo(angle);
    expectValidLayout({ ...plane, panels });
  });

  it('preferisce la prima slopeLine al lato lungo (assunzione MVP)', () => {
    const plane: RoofPlane = { ...rectanglePlane(), mapPolygon: [{ lat: 45, lng: 9 }], slopeLines: [{ id: 'ridge', label: 'Colmo', points: [{ lat: 45, lng: 9 }, { lat: 45.001, lng: 9 }] }] };
    expect(roofAlignmentAngle(plane)).toBeCloseTo(Math.PI / 2);
    expectValidLayout(autoLayoutPlane(plane, config));
  });

  it('sceglie il massimo, conserva area/configurazione e non muta la falda', () => {
    const plane = rectanglePlane();
    const before = JSON.stringify(config);
    const result = autoLayoutPlane(plane, config);
    expect(result.panels).toHaveLength(Math.max(packPanels(plane, config, 'portrait').length, packPanels(plane, config, 'landscape').length));
    expect(result.layoutOrientation).toBe('landscape');
    expect(result.areaM2).toBe(60);
    expect(plane.panels).toEqual([]);
    expect(JSON.stringify(config)).toBe(before);
  });

  it('sceglie portrait a parità anche partendo da landscape', () => {
    const squareConfig = { ...config, pv: { ...config.pv, panel: { ...config.pv.panel, widthM: 1, heightM: 1 } } };
    const result = autoLayoutPlane({ ...rectanglePlane(), layoutOrientation: 'landscape' }, squareConfig);
    expect(result.panels.length).toBeGreaterThan(0);
    expect(result.layoutOrientation).toBe('portrait');
  });

  it.each([0, 30])('non perde il modulo con fit esatto a %s°', (pitchDeg) => {
    const height = (1.76 + 0.7) * Math.cos(pitchDeg * Math.PI / 180);
    const plane = { ...rectanglePlane(pitchDeg), polygon: [{ x: 0, y: 0 }, { x: 1.83, y: 0 }, { x: 1.83, y: height }, { x: 0, y: height }] };
    // Explicit ridge keeps X along the short side rather than the longest edge.
    plane.mapPolygon = [{ lat: 0, lng: 0 }];
    plane.slopeLines = [{ id: 'ridge', label: 'Colmo', points: [{ lat: 0, lng: 0 }, { lat: 0, lng: 0.001 }] }];
    expect(packPanels(plane, config, 'portrait')).toHaveLength(1);
  });

  it('esclude falde non utilizzabili e rimuove eventuali pannelli precedenti', () => {
    const plane = rectanglePlane();
    const excluded = { ...plane, usable: false, panels: packPanels(plane, config) };
    expect(packPanels(excluded, config, 'portrait')).toEqual([]);
    expect(packPanels(excluded, config, 'landscape')).toEqual([]);
    expect(autoLayoutPlane(excluded, config).panels).toEqual([]);
  });

  it.each([NaN, Infinity, -10, 90, 100])('rifiuta pitch non valido %s', (pitchDeg) => {
    const plane = rectanglePlane(pitchDeg);
    expect(packPanels(plane, config)).toEqual([]);
    expect(panelFootprint(plane, packPanels(rectanglePlane(), config)[0], config)).toEqual([]);
  });

  it.each([NaN, Infinity, 0, -1, Number.MIN_VALUE])('rifiuta dimensioni non valide/patologiche %s', (widthM) => {
    const invalid = { ...config, roof: { ...config.roof, panelSpacingM: 0 }, pv: { ...config.pv, panel: { ...config.pv.panel, widthM } } };
    expect(packPanels(rectanglePlane(), invalid)).toEqual([]);
  });
});

describe('contenimento dell’intero modulo', () => {
  it.each([0, 30])('non attraversa una rientranza anche se tutti gli angoli sono interni, pitch %s°', (pitchDeg) => {
    const plane = {
      ...rectanglePlane(pitchDeg),
      polygon: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 4 }, { x: 1, y: 4 },
        { x: 1, y: 0.8 }, { x: 0.7, y: 0.8 }, { x: 0.7, y: 4 }, { x: 0, y: 4 }],
    };
    const result = autoLayoutPlane(plane, config);
    expect(result.panels.length).toBeGreaterThan(0);
    for (const panel of result.panels) {
      const corners = panelFootprint(result, panel, config);
      for (const tx of [0, 0.25, 0.5, 0.75, 1]) for (const ty of [0, 0.25, 0.5, 0.75, 1]) {
        const point = {
          x: corners[0].x + tx * (corners[1].x - corners[0].x) + ty * (corners[3].x - corners[0].x),
          y: corners[0].y + tx * (corners[1].y - corners[0].y) + ty * (corners[3].y - corners[0].y),
        };
        expect(pointInPolygon(point, plane.polygon)).toBe(true);
      }
    }
  });

  it('consente il contatto esatto col bordo quando il margine è esplicitamente zero', () => {
    const cfg = { ...config, roof: { ...config.roof, panelMarginM: 0, panelSpacingM: 0 }, pv: { ...config.pv, panel: { ...config.pv.panel, widthM: 1, heightM: 1 } } };
    const plane = { ...rectanglePlane(0), polygon: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }] };
    expect(packPanels(plane, cfg)).toHaveLength(12);
  });
});

describe('ostacoli del tetto', () => {
  it.each(['portrait', 'landscape'] as const)(
    'esclude gli ostacoli dal layout %s e ripristina lo spazio quando vengono rimossi',
    (layoutOrientation) => {
      const plane = { ...defaultRoofPlane(), layoutOrientation };
      const initial = packPanels(plane, config);
      expect(initial.length).toBeGreaterThan(0);
      const center = initial[0].position;
      const partialObstacle = {
        id: 'small-obstacle',
        label: 'Comignolo',
        mapPolygon: [],
        polygon: [
          { x: center.x - 0.1, y: center.y - 0.1 },
          { x: center.x + 0.1, y: center.y - 0.1 },
          { x: center.x + 0.1, y: center.y + 0.1 },
          { x: center.x - 0.1, y: center.y + 0.1 },
        ],
      };
      const partial = packPanels({ ...plane, obstacles: [partialObstacle] }, config);
      expect(partial.length).toBeGreaterThan(0);
      expect(partial.length).toBeLessThan(initial.length);
      expect(partial.some(panel => panel.position.x === center.x && panel.position.y === center.y)).toBe(false);

      // Un ostacolo coincidente con il tetto rende tutta la falda indisponibile.
      const obstructed = {
        ...plane,
        obstacles: [{
          id: 'obstacle',
          label: 'Lucernario',
          polygon: plane.polygon,
          mapPolygon: [],
        }],
      };
      expect(packPanels(obstructed, config)).toHaveLength(0);
      const restored = packPanels({ ...obstructed, obstacles: [] }, config);
      expect(restored.map(panel => panel.position)).toEqual(initial.map(panel => panel.position));
    },
  );
});
