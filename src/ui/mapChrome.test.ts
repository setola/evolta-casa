// @vitest-environment jsdom
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

// These are Google's live DOM shapes, not additional controls rendered by us.
// Read the actual CSS rule to catch missing selectors without duplicating them.
function counterScaleSelector() {
  const style = document.createElement("style");
  style.textContent = fs.readFileSync("src/styles.css", "utf8");
  document.head.appendChild(style);
  const rule = Array.from(style.sheet!.cssRules).find((entry) =>
    entry instanceof CSSStyleRule &&
    entry.style.getPropertyValue("zoom") === "var(--roof-map-ui-scale, 1)",
  ) as CSSStyleRule | undefined;
  expect(rule).toBeDefined();
  return rule!.selectorText;
}

afterEach(() => {
  document.head.querySelectorAll("style").forEach((style) => style.remove());
  document.body.replaceChildren();
});

describe("unscaled Google Maps chrome", () => {
  it("counter-scales the logo, camera controls, fullscreen and attribution exactly once", () => {
    document.body.innerHTML = `
      <div class="roof-map-viewport"><div class="gm-style">
        <div id="scene"><div><div class="gmnoprint"><button>Vertex</button></div></div></div>
        <div id="logo"><div><a href="https://maps.google.com/maps?ll=45,9"><div><img alt="Google"></div></a></div></div>
        <div id="camera"><div class="gmnoprint gm-bundled-control"><gmp-internal-camera-control><button>Camera</button></gmp-internal-camera-control></div></div>
        <div id="fullscreen"><button class="gm-control-active gm-fullscreen-control">Fullscreen</button></div>
        <div id="attribution"><div><div class="gmnoprint"><div class="gm-style-cc"><a href="https://www.google.com/maps">Terms</a></div></div></div></div>
      </div></div>`;
    const selector = counterScaleSelector();
    for (const id of ["logo", "camera", "fullscreen", "attribution"]) {
      expect(document.getElementById(id)!.matches(selector), id).toBe(true);
    }
    expect(document.querySelectorAll(selector)).toHaveLength(4);
    expect(document.getElementById("scene")!.matches(selector)).toBe(false);
    // Scaling a nested control as well would apply the inverse scale twice.
    expect(document.querySelector("#camera button")!.matches(selector)).toBe(false);
    expect(document.querySelector(".gm-style-cc")!.matches(selector)).toBe(false);
  });
});
