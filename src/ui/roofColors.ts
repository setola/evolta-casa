import type { CSSProperties } from "react";
import type { RoofPlane } from "../types";

const PALETTE = ["#2563eb", "#0f766e", "#7c3aed", "#c2410c", "#a16207", "#0891b2", "#4d7c0f", "#a21caf"];
const validColor = (color?: string) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color);

function generatedColor(index: number) {
  // Avoid exhausting the finite rounded hue ring in large imported projects.
  if (index >= 360) {
    const value = ((index - 360) * 0x9e3779 + 0x5171a5) % 0x1000000;
    return `#${value.toString(16).padStart(6, "0")}`;
  }
  const hue = ((index * 137.508 + 210) % 360) / 60;
  const chroma = 0.64;
  const secondary = chroma * (1 - Math.abs(hue % 2 - 1));
  const channels = hue < 1 ? [chroma, secondary, 0]
    : hue < 2 ? [secondary, chroma, 0]
    : hue < 3 ? [0, chroma, secondary]
    : hue < 4 ? [0, secondary, chroma]
    : hue < 5 ? [secondary, 0, chroma] : [chroma, 0, secondary];
  return `#${channels.map((channel) => Math.round((channel + 0.12) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function availableColor(used: Set<string>) {
  const preset = PALETTE.find((color) => !used.has(color));
  if (preset) return preset;
  for (let index = 0; index <= Math.min(used.size, 0xffffff) + 360; index++) {
    const color = generatedColor(index);
    if (!used.has(color)) return color;
  }
  throw new Error("Nessun colore distinto disponibile.");
}

export function nextRoofColor(planes: RoofPlane[]) {
  return availableColor(new Set(planes.filter((plane) => validColor(plane.color)).map((plane) => plane.color!.toLowerCase())));
}

/** Persist assignments: deletion, renaming and reload must not recolor other roofs. */
export function assignRoofColors(planes: RoofPlane[]): RoofPlane[] {
  const reserved = new Set(planes.filter((plane) => validColor(plane.color)).map((plane) => plane.color!.toLowerCase()));
  const assigned = new Set<string>();
  return planes.map((plane) => {
    let color = validColor(plane.color) ? plane.color!.toLowerCase() : undefined;
    if (!color || assigned.has(color)) color = availableColor(reserved);
    assigned.add(color);
    reserved.add(color);
    return plane.color === color ? plane : { ...plane, color };
  });
}

export function roofColor(plane?: RoofPlane) {
  return validColor(plane?.color) ? plane!.color!.toLowerCase() : PALETTE[0];
}

export function roofPlaneStyle(plane: RoofPlane): CSSProperties {
  const color = roofColor(plane);
  const channels = [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16));
  return {
    "--roof-plane-color": color,
    borderColor: color,
    backgroundColor: `rgba(${channels.join(", ")}, 0.09)`,
  } as CSSProperties;
}
