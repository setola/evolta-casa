import type { AppConfig, PanelPlacement, Point, RoofPlane } from "../types";
import { newId } from "../id";

export function polygonArea(points: Point[]) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}
export function centroid(points: Point[]): Point {
  return {
    x: points.reduce((a, p) => a + p.x, 0) / points.length,
    y: points.reduce((a, p) => a + p.y, 0) / points.length,
  };
}
export function defaultRoofPlane(): RoofPlane {
  const polygon = [
    { x: 0, y: 0 },
    { x: 9, y: 0 },
    { x: 9, y: 5 },
    { x: 0, y: 5 },
  ];
  return {
    id: newId("plane"),
    label: "Falda 1",
    polygon,
    areaM2: polygonArea(polygon),
    azimuthDeg: 180,
    pitchPreset: "normal",
    pitchDeg: 30,
    usable: true,
    layoutOrientation: "portrait",
    panels: [],
  };
}
export function roofAlignmentAngle(plane: RoofPlane) {
  const slope = plane.slopeLines?.[0];
  const origin = plane.mapPolygon?.[0];
  if (slope && origin) {
    const latitudeRadians = (origin.lat * Math.PI) / 180;
    const dx =
      (slope.points[1].lng - slope.points[0].lng) *
      111320 *
      Math.cos(latitudeRadians);
    const dy = (slope.points[1].lat - slope.points[0].lat) * 110540;
    if (Math.hypot(dx, dy) > 0.01) return Math.atan2(dy, dx);
  }

  let longestEdge = { dx: 1, dy: 0, length: 0 };
  for (let index = 0; index < plane.polygon.length; index++) {
    const start = plane.polygon[index];
    const end = plane.polygon[(index + 1) % plane.polygon.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length > longestEdge.length) longestEdge = { dx, dy, length };
  }
  return Math.atan2(longestEdge.dy, longestEdge.dx);
}

function rotatePoint(point: Point, angle: number): Point {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    x: point.x * cosine - point.y * sine,
    y: point.x * sine + point.y * cosine,
  };
}

const GEOMETRY_EPSILON = 1e-9;

function panelDimensions(cfg: AppConfig, orientation: RoofPlane["layoutOrientation"]) {
  const { widthM, heightM } = cfg.pv.panel;
  if (![widthM, heightM].every((value) => Number.isFinite(value) && value > 0))
    return undefined;
  return orientation === "portrait"
    ? { w: widthM, h: heightM }
    : { w: heightM, h: widthM };
}

function finitePoint(point: Point) {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function slopeTransform(plane: RoofPlane) {
  // MVP: X follows the first ridge/slopeLine (otherwise the longest edge),
  // and the entire plane slopes along perpendicular Y. Polygons are plan metres.
  if (!Number.isFinite(plane.pitchDeg) || plane.pitchDeg < 0 || plane.pitchDeg >= 90)
    return undefined;
  const cosine = Math.cos((plane.pitchDeg * Math.PI) / 180);
  const angle = roofAlignmentAngle(plane);
  if (!Number.isFinite(angle) || cosine < GEOMETRY_EPSILON) return undefined;
  return {
    angle,
    toSlope(point: Point): Point {
      const aligned = rotatePoint(point, -angle);
      return { x: aligned.x, y: aligned.y / cosine };
    },
    toPlan(point: Point): Point {
      return rotatePoint({ x: point.x, y: point.y * cosine }, angle);
    },
  };
}

/** Four plan-metre corners; panel dimensions remain physical slope dimensions. */
export function panelFootprint(
  plane: RoofPlane,
  panel: PanelPlacement,
  cfg: AppConfig,
): Point[] {
  const transform = slopeTransform(plane);
  const dimensions = panelDimensions(cfg, plane.layoutOrientation);
  if (!transform || !dimensions || !finitePoint(panel.position)) return [];
  const { w, h } = dimensions;
  const center = transform.toSlope(panel.position);
  return [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ].map((offset) => transform.toPlan({ x: center.x + offset.x, y: center.y + offset.y }));
}

export function autoLayoutPlane(plane: RoofPlane, cfg: AppConfig): RoofPlane {
  const portrait = packPanels(plane, cfg, "portrait");
  const landscape = packPanels(plane, cfg, "landscape");
  return landscape.length > portrait.length
    ? { ...plane, layoutOrientation: "landscape", panels: landscape }
    : { ...plane, layoutOrientation: "portrait", panels: portrait };
}

export function packPanels(
  plane: RoofPlane,
  cfg: AppConfig,
  orientation = plane.layoutOrientation,
): PanelPlacement[] {
  if (!plane.usable || plane.polygon.length < 3) return [];
  const transform = slopeTransform(plane);
  const dimensions = panelDimensions(cfg, orientation);
  const margin = cfg.roof.panelMarginM, gap = cfg.roof.panelSpacingM;
  if (!transform || !dimensions ||
      ![margin, gap].every((value) => Number.isFinite(value) && value >= 0) ||
      !plane.polygon.every(finitePoint) ||
      !(plane.obstacles ?? []).every((obstacle) => obstacle.polygon.every(finitePoint)))
    return [];
  const { angle } = transform;
  const alignedRoof = plane.polygon.map(transform.toSlope);
  const alignedObstacles = (plane.obstacles ?? []).map((obstacle) =>
    obstacle.polygon.map(transform.toSlope),
  );
  const xs = alignedRoof.map((point) => point.x);
  const ys = alignedRoof.map((point) => point.y);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const { w, h } = dimensions;
  const columns = Math.max(0, Math.floor((maxX - minX - 2 * margin + gap + GEOMETRY_EPSILON) / (w + gap)));
  const rows = Math.max(0, Math.floor((maxY - minY - 2 * margin + gap + GEOMETRY_EPSILON) / (h + gap)));
  // Reject pathological geometry/configurations rather than hanging the preview.
  if (!Number.isSafeInteger(rows * columns) || rows * columns > 1_000_000) return [];
  const out: PanelPlacement[] = [];
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const x = minX + margin + column * (w + gap);
      const y = minY + margin + row * (h + gap);
      const rectangle = [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ];
      const insideRoof = rectangleInsidePolygon(rectangle, alignedRoof);
      const overlapsObstacle = alignedObstacles.some((obstacle) =>
        polygonsOverlap(rectangle, obstacle),
      );
      if (insideRoof && !overlapsObstacle) {
        const alignedCenter = { x: x + w / 2, y: y + h / 2 };
        const center = transform.toPlan(alignedCenter);
        out.push({
          id: newId("panel"),
          roofPlaneId: plane.id,
          position: center,
          rotationDeg:
            (angle * 180) / Math.PI + (orientation === "portrait" ? 0 : 90),
          validGeometry: true,
          manuallyPlaced: false,
        });
      }
    }
  return out;
}
function rectangleInsidePolygon(rectangle: Point[], polygon: Point[]) {
  if (!rectangle.every((point) => pointInPolygon(point, polygon))) return false;
  // Corners alone miss concave notches. No roof-boundary segment may enter
  // the open interior of the axis-aligned candidate rectangle. Clip each
  // segment to a slightly inset rectangle, allowing exact boundary contact.
  const low = { x: rectangle[0].x + GEOMETRY_EPSILON, y: rectangle[0].y + GEOMETRY_EPSILON };
  const high = { x: rectangle[2].x - GEOMETRY_EPSILON, y: rectangle[2].y - GEOMETRY_EPSILON };
  return !polygon.some((start, index) => {
    const end = polygon[(index + 1) % polygon.length];
    let enter = 0, exit = 1;
    for (const axis of ["x", "y"] as const) {
      const delta = end[axis] - start[axis];
      if (Math.abs(delta) <= GEOMETRY_EPSILON) {
        if (start[axis] < low[axis] || start[axis] > high[axis]) return false;
      } else {
        const a = (low[axis] - start[axis]) / delta;
        const b = (high[axis] - start[axis]) / delta;
        enter = Math.max(enter, Math.min(a, b));
        exit = Math.min(exit, Math.max(a, b));
        if (enter > exit) return false;
      }
    }
    return enter <= exit;
  });
}

export function pointInPolygon(p: Point, poly: Point[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (pointOnSegment(p, a, b)) return true;
    const intersect =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}
function pointOnSegment(p: Point, a: Point, b: Point) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length <= GEOMETRY_EPSILON) return Math.hypot(p.x - a.x, p.y - a.y) <= GEOMETRY_EPSILON;
  return Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) <= GEOMETRY_EPSILON * length &&
    p.x >= Math.min(a.x, b.x) - GEOMETRY_EPSILON && p.x <= Math.max(a.x, b.x) + GEOMETRY_EPSILON &&
    p.y >= Math.min(a.y, b.y) - GEOMETRY_EPSILON && p.y <= Math.max(a.y, b.y) + GEOMETRY_EPSILON;
}

function polygonsOverlap(a: Point[], b: Point[]) {
  if (
    a.some((point) => pointInPolygon(point, b)) ||
    b.some((point) => pointInPolygon(point, a))
  )
    return true;
  for (let ai = 0; ai < a.length; ai++)
    for (let bi = 0; bi < b.length; bi++) {
      if (
        segmentsIntersect(
          a[ai],
          a[(ai + 1) % a.length],
          b[bi],
          b[(bi + 1) % b.length],
        )
      )
        return true;
    }
  return false;
}
function segmentsIntersect(a: Point, b: Point, c: Point, d: Point) {
  const cross = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = cross(a, b, c),
    abD = cross(a, b, d),
    cdA = cross(c, d, a),
    cdB = cross(c, d, b);
  return (
    ((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) &&
    ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))
  );
}
export function updatePlaneArea(plane: RoofPlane): RoofPlane {
  return { ...plane, areaM2: polygonArea(plane.polygon) };
}
