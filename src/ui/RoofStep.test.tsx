// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import YAML from "yaml";
import { AppConfigSchema } from "../configSchema";
import { createProject } from "../project";
import { packPanels } from "../engines/roof";
import type { Project } from "../types";
import { App, RoofStep } from "./App";

const config = AppConfigSchema.parse(
  YAML.parse(fs.readFileSync("public/config/assumptions.yaml", "utf8")),
);
config.map.googleMapsApiKey = "test-key";
const points = [
  { lat: 45, lng: 9 },
  { lat: 45, lng: 9.0001 },
  { lat: 45.0001, lng: 9.0001 },
  { lat: 45.0001, lng: 9 },
];
let root: Root;
let container: HTMLDivElement;
let latest: Project;
let mapClick: (event: unknown) => void;
let mapOverlays: Array<{ options: any; getDraggable?: () => boolean }>;

function button(text: string) {
  const found = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent?.trim() === text || element.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function fillInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function drawPoints(vertices = points) {
  await act(async () => {
    vertices.forEach((point) =>
      mapClick({ latLng: { lat: () => point.lat, lng: () => point.lng } }),
    );
  });
}
async function mount(withPlane = true, confirmed = false) {
  const initial = createProject(config);
  initial.location = {
    latitude: 45,
    longitude: 9,
  } as Project["location"];
  initial.roof.detectionMethod = "manual";
  initial.roof.confirmedByUser = confirmed;
  initial.roof.planes = withPlane
    ? [{ ...initial.roof.planes[0], mapPolygon: points, obstacles: [] }]
    : [];
  function Harness() {
    const [project, update] = useState(initial);
    latest = project;
    return (
      <RoofStep
        project={project}
        update={update}
        config={config}
        onConfirm={vi.fn()}
      />
    );
  }
  await act(async () => root.render(<Harness />));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const latLng = (point: { lat: number; lng: number }) => ({
    lat: () => point.lat,
    lng: () => point.lng,
  });
  mapOverlays = [];
  class Overlay {
    listeners = new Map<string, (event: any) => void>();
    constructor(public options: any = {}) { mapOverlays.push(this); }
    setMap(map: unknown) { this.options.map = map; }
    addListener(name: string, callback: (event: any) => void) {
      this.listeners.set(name, callback);
      return { remove: () => this.listeners.delete(name) };
    }
    emit(name: string, event: unknown) { this.listeners.get(name)?.(event); }
  }
  class Marker extends Overlay {
    getDraggable() { return this.options.draggable; }
    getPosition() {
      return typeof this.options.position.lat === "function"
        ? this.options.position
        : latLng(this.options.position);
    }
    setPosition(position: unknown) { this.options.position = position; }
  }
  class OverlayView {
    onAdd() {}
    onRemove() {}
    draw() {}
    getPanes() { return {}; }
    getProjection() {
      return {
        fromContainerPixelToLatLng: ({ x, y }: { x: number; y: number }) => latLng({
          lat: 45 + (y - 100) / 1e6,
          lng: 9 + (x - 100) / 1e6,
        }),
        fromLatLngToContainerPixel: (point: ReturnType<typeof latLng>) => ({
          x: 100 + (point.lng() - 9) * 1e6,
          y: 100 + (point.lat() - 45) * 1e6,
        }),
      };
    }
    setMap(map: unknown) {
      if (map) { this.onAdd(); this.draw(); }
      else this.onRemove();
    }
  }
  class Point {
    constructor(public x: number, public y: number) {}
  }
  class MapMock extends Overlay {
    getCenter() { return latLng({ lat: 45, lng: 9 }); }
    setCenter() {}
    setZoom() {}
    panBy() {}
    addListener(name: string, callback: (event: unknown) => void) {
      if (name === "click") mapClick = callback;
      return super.addListener(name, callback);
    }
  }
  Object.assign(window, {
    google: {
      maps: {
        Map: MapMock,
        event: { trigger: (target: Overlay, name: string, event: unknown) => target.emit?.(name, event) },
        Polygon: Overlay,
        Polyline: Overlay,
        Marker,
        OverlayView,
        Point,
        ControlPosition: { RIGHT_CENTER: 1 },
        SymbolPath: { CIRCLE: 1 },
      },
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  delete (window as any).google;
});

describe("RoofStep working zoom", () => {
  it.each([1, 2, 4])("keeps roof and obstacle vertices editable at %s× with the obstacle form closed", async (scale) => {
    await mount();
    await click("Ostacoli sul tetto");
    await click("Disegna ostacolo sulla mappa");
    const obstaclePoints = [
      { lat: 45.00003, lng: 9.00003 },
      { lat: 45.00003, lng: 9.00006 },
      { lat: 45.00006, lng: 9.00006 },
      { lat: 45.00006, lng: 9.00003 },
    ];
    await drawPoints(obstaclePoints);
    await click("Completa ostacolo");
    await click("Richiudi ostacoli");
    await click(`${scale}×`);
    const viewport = container.querySelector<HTMLDivElement>(".roof-map-viewport")!;
    Object.defineProperties(container.querySelector(".roof-map-canvas")!, {
      clientWidth: { value: 200 },
      clientHeight: { value: 200 },
    });
    viewport.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    viewport.setPointerCapture = vi.fn();
    viewport.hasPointerCapture = () => true;
    viewport.releasePointerCapture = vi.fn();
    async function pointer(type: string, x: number, y: number) {
      const event = new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0,
        clientX: x * scale, clientY: y * scale,
      });
      Object.defineProperty(event, "pointerId", { value: 1 });
      await act(async () => viewport.dispatchEvent(event));
    }

    // Move a saved obstacle while the creation form is collapsed.
    await pointer("pointerdown", 130, 130);
    await pointer("pointermove", 135, 136);
    await pointer("pointerup", 135, 136);
    let obstacle = latest.roof.planes[0].obstacles![0];
    expect(obstacle.mapPolygon[0].lat).toBeCloseTo(45.000036, 9);
    expect(obstacle.mapPolygon[0].lng).toBeCloseTo(9.000035, 9);

    // Moving a roof corner must preserve the obstacle's geographic position.
    await pointer("pointerdown", 100, 100);
    await pointer("pointermove", 90, 90);
    await pointer("pointerup", 90, 90);
    expect(latest.roof.planes[0].mapPolygon![0].lat).toBeCloseTo(44.99999, 9);
    expect(latest.roof.planes[0].mapPolygon![0].lng).toBeCloseTo(8.99999, 9);
    expect(latest.roof.planes[0].obstacles![0].mapPolygon).toEqual(obstacle.mapPolygon);

    // Select/delete an obstacle point without reopening the form.
    await pointer("pointerdown", 135, 136);
    await pointer("pointerup", 135, 136);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" })));
    obstacle = latest.roof.planes[0].obstacles![0];
    expect(obstacle.mapPolygon).toEqual(obstaclePoints.slice(1));

    await pointer("pointerdown", 90, 90);
    await pointer("pointerup", 90, 90);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" })));
    expect(latest.roof.planes[0].mapPolygon).toEqual(points.slice(1));
    expect(latest.roof.planes[0].obstacles![0].mapPolygon).toEqual(obstaclePoints.slice(1));
    expect(latest.roof.confirmedByUser).toBe(false);
  });

  it("starts enlarged and changes zoom without modifying roof geometry", async () => {
    await mount();
    const original = structuredClone(latest.roof);
    const canvas = container.querySelector<HTMLElement>(".roof-map-canvas")!;
    expect(canvas.style.transform).toBe("scale(2)");
    expect(button("2×").getAttribute("aria-pressed")).toBe("true");
    await click("4×");
    expect(canvas.style.transform).toBe("scale(4)");
    expect(canvas.style.width).toBe("25%");
    expect(button("4×").getAttribute("aria-pressed")).toBe("true");
    expect(latest.roof).toEqual({ ...original, mapMagnification: 4 });
    await click("1×");
    expect(canvas.style.transform).toBe("scale(1)");
    expect(latest.roof).toEqual({ ...original, mapMagnification: 1 });
  });

  it("preserves a drawing in progress when changing magnification", async () => {
    await mount(false);
    await click("+ Disegna la prima falda");
    await drawPoints();
    await click("4×");
    expect(container.textContent).toContain("4 punti inseriti");
    await click("Completa falda");
    expect(latest.roof.planes[0].mapPolygon).toEqual(points);
  });
});

describe("RoofStep compact plane controls", () => {
  it("keeps the first textual CTA, then uses accessible plus/minus icons", async () => {
    await mount(false);
    expect(button("+ Disegna la prima falda").disabled).toBe(false);
    expect(container.querySelector(".roof-add-plane-icon")).toBeNull();
    await click("+ Disegna la prima falda");
    await drawPoints();
    await click("Completa falda");
    const add = button("Disegna un’altra falda");
    expect(add.textContent?.trim()).toBe("");
    expect(add.title).toBe("Disegna un’altra falda");
    expect(add.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".roof-draw-start")).toBeNull();
    const remove = button("Elimina Falda 1");
    expect(remove.textContent?.trim()).toBe("");
    expect(remove.title).toBe("Elimina Falda 1");
    await click("Disegna un’altra falda");
    await drawPoints();
    await click("Completa falda");
    expect(latest.roof.planes).toHaveLength(2);
    await click("Elimina Falda 2");
    expect(latest.roof.planes).toHaveLength(1);
    expect(latest.roof.planes[0].label).toBe("Falda 1");
    await click("Elimina Falda 1");
    expect(latest.roof.planes).toEqual([]);
    expect(button("+ Disegna la prima falda").disabled).toBe(false);
    expect(container.querySelector(".roof-add-plane-icon")).toBeNull();
  });
});

describe("RoofStep compact obstacle controls", () => {
  it("uses the first textual CTA, then plus/minus while keeping obstacle types available", async () => {
    await mount();
    await click("Ostacoli sul tetto");
    expect(button("Disegna ostacolo sulla mappa").textContent).toBe("Disegna ostacolo sulla mappa");
    await click("Disegna ostacolo sulla mappa");
    await drawPoints();
    await click("Completa ostacolo");
    const add = button("Disegna un altro ostacolo");
    expect(add.textContent?.trim()).toBe("");
    expect(add.title).toBe("Disegna un altro ostacolo");
    expect(add.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    const remove = button("Elimina Comignolo 1");
    expect(remove.textContent?.trim()).toBe("");
    expect(remove.title).toBe("Elimina Comignolo 1");
    const select = container.querySelector<HTMLSelectElement>(".roof-obstacle-toolbar select")!;
    await act(async () => {
      select.value = "Lucernario";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Disegna un altro ostacolo");
    await drawPoints();
    await click("Completa ostacolo");
    expect(latest.roof.planes[0].obstacles?.map((obstacle) => obstacle.label)).toEqual(["Comignolo 1", "Lucernario 2"]);
    await click("Elimina Lucernario 2");
    expect(latest.roof.planes[0].obstacles).toHaveLength(1);
    await click("Elimina Comignolo 1");
    expect(latest.roof.planes[0].obstacles).toEqual([]);
    expect(latest.roof.planes[0].mapPolygon).toEqual(points);
    expect(button("Disegna ostacolo sulla mappa").disabled).toBe(false);
    expect(container.querySelector(".roof-obstacle-toolbar.has-items")).toBeNull();
  });
});

describe("RoofStep plane naming", () => {
  it("assigns a custom name while drawing and preserves it across zoom changes", async () => {
    await mount(false);
    await click("+ Disegna la prima falda");
    const input = container.querySelector<HTMLInputElement>("#roof-draft-plane-name")!;
    expect(input.value).toBe("Falda 1");
    await drawPoints();
    await fillInput(input, "   ");
    expect(button("Completa falda").disabled).toBe(true);
    await fillInput(input, "  Falda sud  ");
    await click("4×");
    expect(input.value).toBe("  Falda sud  ");
    await click("Completa falda");
    expect(latest.roof.planes[0].label).toBe("Falda sud");
    expect(latest.roof.planes[0].mapPolygon).toEqual(points);
    expect(container.querySelector("#roof-draft-plane-name")).toBeNull();
    expect(container.querySelector<HTMLInputElement>(".roof-plane-name")!.value).toBe("Falda sud");
  });

  it("renames saved planes in Roof without repacking panels or changing geometry", async () => {
    await mount();
    const original = structuredClone(latest.roof.planes[0]);
    const input = container.querySelector<HTMLInputElement>(".roof-plane-name")!;
    await fillInput(input, "  Falda ovest  ");
    await act(async () => input.blur());
    expect(latest.roof.planes[0]).toEqual({ ...original, label: "Falda ovest" });
    await click("Ostacoli sul tetto");
    expect(container.querySelector("#roof-obstacle-editor option")!.textContent).toBe("Falda ovest");
    await click("Suddivisioni interne");
    expect(container.querySelector("#roof-subdivision-editor option")!.textContent).toBe("Falda ovest");
    await fillInput(input, " ");
    await act(async () => input.blur());
    expect(latest.roof.planes[0].label).toBe("Falda 1");
  });

  it("discards the name together with a cancelled drawing", async () => {
    await mount(false);
    await click("+ Disegna la prima falda");
    await fillInput(container.querySelector<HTMLInputElement>("#roof-draft-plane-name")!, "Bozza da scartare");
    await click("Annulla disegno");
    await click("+ Disegna la prima falda");
    expect(container.querySelector<HTMLInputElement>("#roof-draft-plane-name")!.value).toBe("Falda 1");
    expect(latest.roof.planes).toEqual([]);
  });
});

describe("Roof automatic preview", () => {
  it.each([1, 2, 4])("shows only read-only panel footprints at %s× and preserves geometry when editing again", async (scale) => {
    await mount();
    await click(`${scale}×`);
    const originalPolygon = structuredClone(latest.roof.planes[0].mapPolygon);
    const plane = latest.roof.planes[0];
    expect(plane.panels.length).toBe(Math.max(
      packPanels(plane, config, "portrait").length,
      packPanels(plane, config, "landscape").length,
    ));
    await click("Mostra disposizione automatica");
    expect(container.querySelector(".roof-preview-summary")).not.toBeNull();
    expect(container.querySelector(".roof-preview-planes")!.textContent).toContain(plane.label);
    expect(container.querySelector(".roof-plane-name")).toBeNull();
    const panels = mapOverlays.filter((overlay) => overlay.options.map && overlay.options.fillColor === "#1570a6");
    expect(panels).toHaveLength(latest.roof.planes[0].panels.length);
    expect(panels.every((overlay) => overlay.options.clickable === false)).toBe(true);
    expect(mapOverlays.some((overlay) => overlay.options.map && overlay.getDraggable?.())).toBe(false);
    expect(button("Continua ai consumi ›").disabled).toBe(false);
    await click("Modifica superfici");
    expect(container.querySelector(".roof-plane-name")).not.toBeNull();
    expect(latest.roof.planes[0].mapPolygon).toEqual(originalPolygon);
    expect(container.querySelector<HTMLElement>(".roof-map-canvas")!.style.transform).toBe(`scale(${scale})`);
  });

  it("does not continue with zero capacity and lets the user correct the surfaces", async () => {
    await mount();
    await act(async () => container.querySelector<HTMLButtonElement>("[aria-label^='Escludi']")!.click());
    await click("Mostra disposizione automatica");
    expect(button("Continua ai consumi ›").disabled).toBe(true);
    expect(container.querySelector("[role='alert']")!.textContent).toContain("Nessun pannello");
    await click("Modifica superfici");
    await act(async () => container.querySelector<HTMLButtonElement>("[aria-label^='Includi']")!.click());
    await click("Mostra disposizione automatica");
    expect(button("Continua ai consumi ›").disabled).toBe(false);
  });

  it("redirects the legacy Panels URL to Roof without losing the saved project", async () => {
    const project = createProject(config);
    project.location = { latitude: 45, longitude: 9 } as Project["location"];
    project.roof.planes[0].mapPolygon = points;
    project.roof.mapMagnification = 4;
    localStorage.setItem("evolta-casa:current-project", JSON.stringify(project));
    window.history.replaceState(null, "", "/pannelli/?legacy=1#map");
    await act(async () => root.render(<App config={config} />));
    expect(window.location.pathname).toBe("/tetto");
    expect(window.location.search).toBe("?legacy=1");
    expect(window.location.hash).toBe("#map");
    expect(container.querySelector<HTMLElement>(".roof-map-canvas")!.style.transform).toBe("scale(4)");
    await act(async () => {
      window.history.pushState(null, "", "/pannelli");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(window.location.pathname).toBe("/tetto");
    expect(JSON.parse(localStorage.getItem("evolta-casa:current-project")!).id).toBe(project.id);
  });
});

describe("Working zoom between wizard steps", () => {
  it.each([2, 4])("keeps %s× after confirming surfaces, reloading, and going back", async (scale) => {
    const project = createProject(config);
    project.location = { latitude: 45, longitude: 9 } as Project["location"];
    project.roof.detectionMethod = "manual";
    project.roof.planes[0].mapPolygon = points;
    project.roof.planes[0].label = "Falda sud";
    localStorage.setItem("evolta-casa:current-project", JSON.stringify(project));
    window.history.replaceState(null, "", "/tetto");
    await act(async () => root.render(<App config={config} />));
    await click(`${scale}×`);
    await click("Suddivisioni interne");
    await click("+ Indica separazione falda");
    await drawPoints(points.slice(0, 2));
    await click("Salva separazione");
    await click("Mostra disposizione automatica");
    expect(window.location.pathname).toBe("/tetto");
    expect(container.querySelector(".roof-preview-summary")).not.toBeNull();
    expect(container.querySelector("#roof-subdivision-toggle")).toBeNull();
    expect(container.querySelector(".roof-preview-planes")!.textContent).toContain("Falda sud");
    expect(container.querySelector<HTMLElement>(".roof-map-canvas")!.style.transform).toBe(`scale(${scale})`);
    expect(button(`${scale}×`).getAttribute("aria-pressed")).toBe("true");
    await click("Continua ai consumi ›");
    expect(window.location.pathname).toBe("/consumi");
    expect(container.querySelector(".cw-stepper")!.textContent).not.toContain("Pannelli");
    expect(container.querySelector(".cw-stepper .current")!.textContent).toBe("3Consumi");

    // Reload in Consumption, then return directly to Roof (no Panels step).
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<App config={config} />));
    expect(container.querySelector("h1")!.textContent).toBe("Consumi attuali");
    await click("Indietro");
    expect(container.querySelector<HTMLElement>(".roof-map-canvas")!.style.transform).toBe(`scale(${scale})`);
    const nextScale = scale === 4 ? 2 : 4;
    await click(`${nextScale}×`);
    expect(window.location.pathname).toBe("/tetto");
    expect(container.querySelector<HTMLElement>(".roof-map-canvas")!.style.transform).toBe(`scale(${nextScale})`);
    const saved = JSON.parse(localStorage.getItem("evolta-casa:current-project")!);
    expect(saved.roof.mapMagnification).toBe(nextScale);
    expect(saved.roof.confirmedByUser).toBe(true);
    expect(saved.roof.planes[0].mapPolygon).toEqual(points);
    expect(saved.roof.planes[0].label).toBe("Falda sud");
    expect(saved.roof.planes[0].slopeLines[0].points).toEqual(points.slice(0, 2));
  });
});

describe("RoofStep subdivisions", () => {
  it.each([1, 2, 4])("draws, adjusts, saves and removes a separation at %s× before confirmation", async (scale) => {
    await mount(true, true);
    await click(`${scale}×`);
    expect(button("Suddivisioni interne").getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("#roof-subdivision-editor")).toBeNull();
    await click("Suddivisioni interne");
    await click("+ Indica separazione falda");
    expect(button("Mostra disposizione automatica").disabled).toBe(true);
    expect(button("Disegna un’altra falda").disabled).toBe(true);
    expect(button("Ostacoli sul tetto").disabled).toBe(true);
    await drawPoints();
    expect(container.textContent).toContain("2/2 estremi");
    const viewport = container.querySelector<HTMLDivElement>(".roof-map-viewport")!;
    Object.defineProperties(container.querySelector(".roof-map-canvas")!, {
      clientWidth: { value: 200 }, clientHeight: { value: 200 },
    });
    viewport.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    viewport.setPointerCapture = vi.fn();
    viewport.hasPointerCapture = () => true;
    viewport.releasePointerCapture = vi.fn();
    for (const [type, x, y] of [["pointerdown", 100, 100], ["pointermove", 120, 120], ["pointerup", 120, 120]] as const) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x * scale, clientY: y * scale });
      Object.defineProperty(event, "pointerId", { value: 1 });
      await act(async () => viewport.dispatchEvent(event));
    }
    await click("Salva separazione");
    const plane = latest.roof.planes[0];
    expect(plane.slopeLines).toHaveLength(1);
    expect(plane.slopeLines![0].points[0].lat).toBeCloseTo(45.00002, 9);
    expect(plane.slopeLines![0].points[0].lng).toBeCloseTo(9.00002, 9);
    expect(plane.slopeLines![0].points[1]).toEqual(points[1]);
    expect(plane.mapPolygon).toEqual(points);
    expect(plane.panels.map(({ id: _id, ...panel }) => panel)).toEqual(
      packPanels(plane, config).map(({ id: _id, ...panel }) => panel),
    );
    expect(latest.roof.confirmedByUser).toBe(false);
    expect(button("Mostra disposizione automatica").disabled).toBe(false);
    await click("Suddivisioni interne");
    await click("Suddivisioni interne");
    expect(container.textContent).toContain("Separazione falda 1");
    await click("Elimina separazione");
    expect(latest.roof.planes[0].slopeLines).toEqual([]);
    expect(latest.roof.planes[0].panels.map(({ id: _id, ...panel }) => panel)).toEqual(
      packPanels(latest.roof.planes[0], config).map(({ id: _id, ...panel }) => panel),
    );
  });

  it("discards a separation draft when collapsed or its target plane changes", async () => {
    await mount();
    await click("Disegna un’altra falda");
    await drawPoints();
    await click("Completa falda");
    await click("Suddivisioni interne");
    await click("+ Indica separazione falda");
    await drawPoints();
    const select = container.querySelector<HTMLSelectElement>("#roof-subdivision-editor select")!;
    await act(async () => {
      select.value = latest.roof.planes[1].id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(button("Mostra disposizione automatica").disabled).toBe(false);
    expect(container.textContent).not.toContain("Salva separazione");
    await click("+ Indica separazione falda");
    await drawPoints();
    await click("Suddivisioni interne");
    expect(container.querySelector("#roof-subdivision-editor")).toBeNull();
    expect(button("Mostra disposizione automatica").disabled).toBe(false);
    expect(latest.roof.planes.every((plane) => !plane.slopeLines?.length)).toBe(true);
  });

  it("cancels the separation draft when its plane is deleted", async () => {
    await mount();
    await click("Suddivisioni interne");
    await click("+ Indica separazione falda");
    await drawPoints();
    await click("Elimina Falda 1");
    expect(container.querySelector("#roof-subdivision-editor")).toBeNull();
    await click("+ Disegna la prima falda");
    expect(container.textContent).toContain("0 punti inseriti");
  });
});

describe("RoofStep optional settings", () => {
  it("keeps drawing and confirmation primary with both advanced sections collapsed", async () => {
    await mount();
    expect(button("Disegna un’altra falda").disabled).toBe(false);
    expect(button("Mostra disposizione automatica").disabled).toBe(false);
    expect(button("Inclinazione del tetto").getAttribute("aria-expanded")).toBe("false");
    expect(button("Ostacoli sul tetto").getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("#roof-pitch-editor")).toBeNull();
    expect(container.querySelector("#roof-obstacle-editor")).toBeNull();
    expect(container.textContent).not.toContain("Molto inclinato");
    expect(container.textContent).not.toContain("Tipo di ostacolo");
    const controls = Array.from(container.querySelectorAll(".roof-drawing-panel button"));
    expect(controls.indexOf(button("Mostra disposizione automatica"))).toBeLessThan(
      controls.indexOf(button("Inclinazione del tetto")),
    );
  });

  it("opens pitch only on request and preserves its value when collapsed", async () => {
    await mount();
    const original = structuredClone(latest.roof);
    await click("Inclinazione del tetto");
    expect(button("Inclinazione del tetto").getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("#roof-pitch-editor")?.getAttribute("aria-labelledby")).toBe("roof-pitch-toggle");
    expect(latest.roof).toEqual(original);
    await click("Molto inclinato");
    const selected = structuredClone(latest.roof);
    expect(selected.planes[0].pitchPreset).toBe("steep");
    await click("Inclinazione del tetto");
    expect(container.querySelector("#roof-pitch-editor")).toBeNull();
    expect(latest.roof).toEqual(selected);
    await click("Inclinazione del tetto");
    expect(button("Molto inclinato").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("#roof-obstacle-editor")).toBeNull();
  });

  it("cancels only the obstacle draft when its accordion is collapsed", async () => {
    await mount();
    await click("Ostacoli sul tetto");
    await click("Disegna ostacolo sulla mappa");
    await drawPoints();
    expect(button("Mostra disposizione automatica").disabled).toBe(true);
    await click("Ostacoli sul tetto");
    expect(container.querySelector("#roof-obstacle-editor")).toBeNull();
    expect(button("Mostra disposizione automatica").disabled).toBe(false);
    expect(latest.roof.planes[0].obstacles).toEqual([]);
    expect(latest.roof.planes[0].mapPolygon).toEqual(points);
  });
});

describe("RoofStep obstacle disclosure", () => {
  it("offers obstacles only after a plane, initially collapsed", async () => {
    await mount(false);
    expect(container.querySelector("#roof-obstacle-toggle")).toBeNull();
    await click("+ Disegna la prima falda");
    await drawPoints();
    expect(button("Completa falda").disabled).toBe(false);
    await click("Completa falda");
    expect(button("Ostacoli sul tetto").getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(container.querySelector("#roof-obstacle-editor")).toBeNull();
    await click("Ostacoli sul tetto");
    expect(button("Ostacoli sul tetto").getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(container.querySelector("#roof-obstacle-editor")).not.toBeNull();
  });

  it("blocks confirmation during drafts and preserves saved obstacles on close", async () => {
    await mount();
    await click("Disegna un’altra falda");
    expect(button("Mostra disposizione automatica").disabled).toBe(true);
    expect(button("Ostacoli sul tetto").disabled).toBe(true);
    await click("Annulla disegno");
    await click("Ostacoli sul tetto");
    await click("Disegna ostacolo sulla mappa");
    expect(button("Mostra disposizione automatica").disabled).toBe(true);
    expect(button("Disegna un’altra falda").disabled).toBe(true);
    await drawPoints();
    await click("Completa ostacolo");
    expect(latest.roof.planes[0].obstacles).toHaveLength(1);
    expect(latest.roof.confirmedByUser).toBe(false);
    await click("Richiudi ostacoli");
    expect(latest.roof.planes[0].obstacles).toHaveLength(1);
    await click("Ostacoli sul tetto");
    await click("Disegna un altro ostacolo");
    await drawPoints();
    await click("Richiudi ostacoli");
    expect(button("Mostra disposizione automatica").disabled).toBe(false);
    expect(latest.roof.planes[0].obstacles).toHaveLength(1);
  });

  it("cancels the draft when switching obstacle planes", async () => {
    await mount();
    await click("Disegna un’altra falda");
    await drawPoints();
    await click("Completa falda");
    await click("Ostacoli sul tetto");
    await click("Disegna ostacolo sulla mappa");
    await drawPoints();
    const select = container.querySelector<HTMLSelectElement>(
      "#roof-obstacle-editor select",
    )!;
    await act(async () => {
      select.value = latest.roof.planes[1].id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).not.toContain("Completa ostacolo");
    expect(button("Mostra disposizione automatica").disabled).toBe(false);
    expect(latest.roof.planes.every((plane) => !plane.obstacles?.length)).toBe(
      true,
    );
  });

  it("clears the obstacle draft when its plane is deleted", async () => {
    await mount();
    await click("Ostacoli sul tetto");
    await click("Disegna ostacolo sulla mappa");
    await drawPoints();
    await click("Elimina Falda 1");
    expect(latest.roof.planes).toHaveLength(0);
    expect(container.querySelector("#roof-obstacle-editor")).toBeNull();
    await click("+ Disegna la prima falda");
    expect(container.textContent).toContain("0 punti inseriti");
  });

  it("clears an orphan draft when the last usable plane is excluded", async () => {
    await mount();
    await click("Ostacoli sul tetto");
    await click("Disegna ostacolo sulla mappa");
    await drawPoints();
    const exclude = container.querySelector<HTMLButtonElement>(
      "[aria-label^='Escludi']",
    )!;
    await act(async () => exclude.click());
    expect(
      container.querySelector<HTMLSelectElement>(
        "#roof-obstacle-editor select",
      )!.value,
    ).toBe("");
    expect(container.textContent).not.toContain("Completa ostacolo");
    expect(button("Mostra disposizione automatica").disabled).toBe(false);
    expect(button("Disegna ostacolo sulla mappa").disabled).toBe(true);
  });
});
