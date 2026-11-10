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

export function packPanels(
  plane: RoofPlane,
  cfg: AppConfig,
  orientation = plane.layoutOrientation,
): PanelPlacement[] {
  if (!plane.usable || plane.polygon.length < 3) return [];
  const angle = roofAlignmentAngle(plane);
  const alignedRoof = plane.polygon.map((point) => rotatePoint(point, -angle));
  const alignedObstacles = (plane.obstacles ?? []).map((obstacle) =>
    obstacle.polygon.map((point) => rotatePoint(point, -angle)),
  );
  const xs = alignedRoof.map((point) => point.x);
  const ys = alignedRoof.map((point) => point.y);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const margin = cfg.roof.panelMarginM,
    gap = cfg.roof.panelSpacingM;
  const w =
    orientation === "portrait" ? cfg.pv.panel.widthM : cfg.pv.panel.heightM;
  const h =
    orientation === "portrait" ? cfg.pv.panel.heightM : cfg.pv.panel.widthM;
  const out: PanelPlacement[] = [];
  for (let y = minY + margin; y + h <= maxY - margin; y += h + gap)
    for (let x = minX + margin; x + w <= maxX - margin; x += w + gap) {
      const rectangle = [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ];
      const insideRoof = rectangle.every((point) =>
        pointInPolygon(point, alignedRoof),
      );
      const overlapsObstacle = alignedObstacles.some((obstacle) =>
        polygonsOverlap(rectangle, obstacle),
      );
      if (insideRoof && !overlapsObstacle) {
        const alignedCenter = { x: x + w / 2, y: y + h / 2 };
        const center = rotatePoint(alignedCenter, angle);
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
export function pointInPolygon(p: Point, poly: Point[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    const intersect =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
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
