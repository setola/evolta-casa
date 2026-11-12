import { describe, expect, it } from "vitest";
import { defaultRoofPlane } from "../engines/roof";
import { assignRoofColors, nextRoofColor, roofColor, roofPlaneStyle } from "./roofColors";

const plane = (id: string, color?: string) => ({ ...defaultRoofPlane(), id, color });

describe("stable roof colors", () => {
  it("assigns distinct colors beyond the base palette without mutating input", () => {
    const source = Array.from({ length: 30 }, (_, index) => plane(`roof-${index}`));
    const colored = assignRoofColors(source);
    expect(new Set(colored.map((roof) => roof.color)).size).toBe(30);
    expect(colored.every((roof) => /^#[0-9a-f]{6}$/.test(roof.color!))).toBe(true);
    expect(source.every((roof) => roof.color === undefined)).toBe(true);
    expect(assignRoofColors(colored)).toEqual(colored);
    expect(colored.some((roof) => roof.color === nextRoofColor(colored))).toBe(false);
  });

  it("does not exhaust rounded hue colors on a large import", () => {
    const colored = assignRoofColors(Array.from({ length: 1100 }, (_, index) => plane(`import-${index}`)));
    expect(new Set(colored.map((roof) => roof.color)).size).toBe(1100);
  });

  it("preserves colors across reordering, renaming, deletion and serialization", () => {
    const colored = assignRoofColors([plane("a"), plane("b"), plane("c")]);
    const remaining = [{ ...colored[2], label: "Nuovo nome" }, colored[1]];
    const restored = assignRoofColors(JSON.parse(JSON.stringify(remaining)));
    expect(restored.map((roof) => roof.color)).toEqual([colored[2].color, colored[1].color]);
    expect(restored[0].label).toBe("Nuovo nome");
  });

  it("reserves existing colors before assigning missing ones and repairs duplicates", () => {
    const assigned = assignRoofColors([plane("missing"), plane("existing", "#2563EB"), plane("duplicate", "#2563eb"), plane("invalid", "red")]);
    expect(assigned[1].color).toBe("#2563eb");
    expect(new Set(assigned.map((roof) => roof.color)).size).toBe(4);
    expect(assigned[0].color).not.toBe("#2563eb");
  });

  it("uses the map color for both row border and background tint", () => {
    const roof = plane("blue", "#2563eb");
    expect(roofColor(roof)).toBe("#2563eb");
    expect(roofPlaneStyle(roof)).toEqual({
      "--roof-plane-color": "#2563eb",
      borderColor: "#2563eb",
      backgroundColor: "rgba(37, 99, 235, 0.09)",
    });
  });
});
