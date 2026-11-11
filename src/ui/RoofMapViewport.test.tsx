// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapViewportPoint, RoofMapViewport } from "./RoofMapViewport";

let root: Root;
let container: HTMLDivElement;
let viewport: HTMLDivElement;
let map: any;
let markers: any[];
let trigger: ReturnType<typeof vi.fn>;
let detached: ReturnType<typeof vi.fn<() => void>>;
let markerPane: HTMLDivElement;
let projectionShift = { x: 0, y: 0 };

async function mount(magnification = 2) {
  // Maps uses the transformed bounding rect for its container projection, but
  // renders markers relative to the smaller, unscaled canvas (400 × 300).
  projectionShift = { x: 200 * (magnification - 1), y: 150 * (magnification - 1) };
  await act(async () => root.render(
    <RoofMapViewport
      canvasRef={{ current: null }}
      mapRef={{ current: map }}
      overlaysRef={{ current: markers }}
      ready
      magnification={magnification}
    />,
  ));
  viewport = container.querySelector(".roof-map-viewport")!;
  viewport.getBoundingClientRect = () => ({ left: 10, top: 20 }) as DOMRect;
  Object.defineProperties(container.querySelector(".roof-map-canvas")!, {
    clientWidth: { value: 400 },
    clientHeight: { value: 300 },
  });
  viewport.setPointerCapture = vi.fn();
  viewport.hasPointerCapture = () => true;
  viewport.releasePointerCapture = vi.fn();
  trigger.mockClear();
}

async function pointer(type: string, x: number, y: number, target?: Element) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x + 10, clientY: y + 20, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  await act(async () => (target ?? viewport).dispatchEvent(event));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  trigger = vi.fn();
  detached = vi.fn();
  map = { getCenter: () => ({ lat: 150, lng: 200 }), setCenter: vi.fn(), panBy: vi.fn() };
  markers = [];
  markerPane = document.createElement("div");
  const projection = {
    fromContainerPixelToLatLng: ({ x, y }: { x: number; y: number }) => ({ lat: y - projectionShift.y, lng: x - projectionShift.x }),
    fromLatLngToContainerPixel: ({ lat, lng }: { lat: number; lng: number }) => ({ x: lng + projectionShift.x, y: lat + projectionShift.y }),
  };
  class OverlayView {
    onAdd() {}
    draw() {}
    getProjection() { return projection; }
    getPanes() { return { overlayMouseTarget: markerPane }; }
    setMap(value: unknown) {
      if (value) { this.onAdd(); this.draw(); }
      else detached();
    }
  }
  class Point {
    constructor(public x: number, public y: number) {}
  }
  Object.assign(window, { google: { maps: { OverlayView, Point, event: { trigger } } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (window as any).google;
});

describe("RoofMapViewport", () => {
  it.each([1, 2, 4])("converts clicks to unscaled geographic coordinates at %s×", async (scale) => {
    await mount(scale);
    await pointer("pointerdown", 40 * scale, 30 * scale);
    await pointer("pointerup", 40 * scale, 30 * scale);
    expect(trigger).toHaveBeenCalledExactlyOnceWith(map, "click", { latLng: { lat: 30, lng: 40 } });
  });

  it("selects and drags vertices using display-pixel hit testing", async () => {
    let position = { lat: 30, lng: 40 };
    const marker = {
      getDraggable: () => true,
      getPosition: () => position,
      setPosition: vi.fn((next) => { position = next; }),
    };
    markers.push(marker);
    await mount(4);
    await pointer("pointerdown", 160, 120);
    await pointer("pointerup", 160, 120);
    expect(trigger).toHaveBeenLastCalledWith(marker, "click", { latLng: { lat: 30, lng: 40 } });
    await pointer("pointerdown", 160, 120);
    await pointer("pointermove", 200, 160);
    await pointer("pointerup", 200, 160);
    expect(marker.setPosition).toHaveBeenCalledWith({ lat: 40, lng: 50 });
    expect(trigger).toHaveBeenLastCalledWith(marker, "dragend", { latLng: { lat: 40, lng: 50 } });
    expect(map.panBy).not.toHaveBeenCalled();
  });

  it("pans the background without adding a point at the end of the drag", async () => {
    await mount(2);
    await pointer("pointerdown", 100, 100);
    await pointer("pointermove", 120, 110);
    await pointer("pointerup", 120, 110);
    expect(map.panBy).toHaveBeenCalledWith(-10, -5);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("restores a vertex on pointer cancellation without saving it", async () => {
    const marker = { getDraggable: () => true, getPosition: () => ({ lat: 30, lng: 40 }), setPosition: vi.fn() };
    markers.push(marker);
    await mount(2);
    await pointer("pointerdown", 80, 60);
    await pointer("pointermove", 120, 80);
    await pointer("pointercancel", 120, 80);
    expect(marker.setPosition).toHaveBeenLastCalledWith({ lat: 30, lng: 40 });
    expect(trigger).not.toHaveBeenCalled();
  });

  it("blocks legacy touch handlers so Google does not drag vertices a second time", async () => {
    await mount();
    const canvas = container.querySelector(".roof-map-canvas")!;
    const nativeTouch = vi.fn();
    canvas.addEventListener("touchstart", nativeTouch);
    canvas.addEventListener("touchmove", nativeTouch);
    canvas.addEventListener("touchend", nativeTouch);
    await act(async () => {
      for (const type of ["touchstart", "touchmove", "touchend"]) {
        canvas.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
      }
    });
    expect(nativeTouch).not.toHaveBeenCalled();
  });

  it("handles marker buttons through the scaled projection, not native map input", async () => {
    const marker = { getDraggable: () => true, getPosition: () => ({ lat: 30, lng: 40 }), setPosition: vi.fn() };
    markers.push(marker);
    await mount(4);
    viewport.appendChild(markerPane);
    const markerButton = document.createElement("button");
    markerPane.appendChild(markerButton);
    await pointer("pointerdown", 160, 120, markerButton);
    await pointer("pointerup", 160, 120, markerButton);
    expect(trigger).toHaveBeenLastCalledWith(marker, "click", { latLng: { lat: 30, lng: 40 } });
  });

  it("leaves attribution links interactive and detaches the projection on unmount", async () => {
    await mount();
    const link = document.createElement("a");
    viewport.appendChild(link);
    await pointer("pointerdown", 80, 60, link);
    await pointer("pointerup", 80, 60, link);
    expect(trigger).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(detached).toHaveBeenCalledOnce();
    root = createRoot(container);
  });
});

describe("mapViewportPoint", () => {
  it("accounts for viewport offsets as well as magnification", () => {
    expect(mapViewportPoint(180, 260, { left: 100, top: 200 }, 4)).toEqual({ x: 20, y: 15 });
  });
});
