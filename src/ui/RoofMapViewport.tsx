import { useEffect, useRef, type CSSProperties, type PointerEvent, type RefObject } from "react";

type MapRef = RefObject<any>;
type Props = {
  canvasRef: RefObject<HTMLDivElement | null>;
  mapRef: MapRef;
  overlaysRef: RefObject<any[]>;
  ready: boolean;
  magnification: number;
};

/** Convert display pixels back to the unscaled Google Maps viewport. */
export function mapViewportPoint(
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, "left" | "top">,
  magnification: number,
) {
  return {
    x: (clientX - bounds.left) / magnification,
    y: (clientY - bounds.top) / magnification,
  };
}

// Scale the entire viewport, not just its imagery: Google keeps geographic
// projection/measurements unchanged and its attribution remains inside the view.
// Native map input assumes unscaled CSS pixels, so translate pointer input here.
export function RoofMapViewport({
  canvasRef, mapRef, overlaysRef, ready, magnification,
}: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const projectionRef = useRef<any>(null);
  const markerPaneRef = useRef<HTMLElement | null>(null);
  const gestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    marker?: any;
    originalPosition?: any;
  } | null>(null);

  useEffect(() => {
    const google = (window as any).google;
    if (!ready || !mapRef.current || !google?.maps?.OverlayView) return;
    const overlay = new google.maps.OverlayView();
    overlay.onAdd = () => {
      markerPaneRef.current = overlay.getPanes()?.overlayMouseTarget ?? null;
    };
    overlay.draw = () => { projectionRef.current = overlay.getProjection(); };
    overlay.onRemove = () => {
      projectionRef.current = null;
      markerPaneRef.current = null;
    };
    overlay.setMap(mapRef.current);
    return () => {
      gestureRef.current = null;
      projectionRef.current = null;
      markerPaneRef.current = null;
      overlay.setMap(null);
    };
  }, [ready, mapRef]);

  useEffect(() => {
    const map = mapRef.current;
    const google = (window as any).google;
    if (!ready || !map) return;
    const center = map.getCenter();
    google.maps.event.trigger(map, "resize");
    if (center) map.setCenter(center);
  }, [ready, magnification, mapRef]);

  function isMapChrome(target: EventTarget | null) {
    // Keep Google's attribution links and map data/terms controls usable.
    return target instanceof Element &&
      !markerPaneRef.current?.contains(target) &&
      Boolean(target.closest("a, button, [role='button']"));
  }

  function projectionOffset() {
    // Maps' container projection can use the transformed bounding rectangle,
    // while markers are rendered around the unscaled canvas' center. At 1×
    // these centers coincide; at 2×/4×, division by scale alone is not enough.
    // Derive the correction from the live map center rather than assuming how
    // a particular Maps renderer measures its container.
    const canvas = canvasRef.current!;
    const center = projectionRef.current.fromLatLngToContainerPixel(
      mapRef.current.getCenter(),
    );
    return {
      x: center.x - canvas.clientWidth / 2,
      y: center.y - canvas.clientHeight / 2,
    };
  }

  function position(event: PointerEvent<HTMLDivElement>) {
    const bounds = viewportRef.current!.getBoundingClientRect();
    const point = mapViewportPoint(event.clientX, event.clientY, bounds, magnification);
    const google = (window as any).google;
    const offset = projectionOffset();
    return projectionRef.current.fromContainerPixelToLatLng(
      new google.maps.Point(point.x + offset.x, point.y + offset.y),
    );
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (isMapChrome(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!projectionRef.current || gestureRef.current || event.button !== 0) return;
    const bounds = viewportRef.current!.getBoundingClientRect();
    const point = mapViewportPoint(event.clientX, event.clientY, bounds, magnification);
    const offset = projectionOffset();
    let marker: any;
    let nearest = 18;
    // Last drawn marker wins in case of coincident draft/saved vertices.
    [...overlaysRef.current].reverse().forEach((overlay) => {
      if (!overlay.getDraggable?.()) return;
      const pixel = projectionRef.current.fromLatLngToContainerPixel(overlay.getPosition());
      if (!pixel) return;
      const distance = Math.hypot(
        pixel.x - offset.x - point.x,
        pixel.y - offset.y - point.y,
      ) * magnification;
      if (distance < nearest) { nearest = distance; marker = overlay; }
    });
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY,
      lastX: event.clientX, lastY: event.clientY,
      moved: false, marker, originalPosition: marker?.getPosition(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (!gesture.moved && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 4) return;
    gesture.moved = true;
    if (gesture.marker) gesture.marker.setPosition(position(event));
    else mapRef.current.panBy(
      (gesture.lastX - event.clientX) / magnification,
      (gesture.lastY - event.clientY) / magnification,
    );
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
  }

  function finish(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancelled) {
      if (gesture.marker) gesture.marker.setPosition(gesture.originalPosition);
      return;
    }
    const google = (window as any).google;
    if (gesture.marker) {
      google.maps.event.trigger(gesture.marker, gesture.moved ? "dragend" : "click", { latLng: position(event) });
    } else if (!gesture.moved) {
      google.maps.event.trigger(mapRef.current, "click", { latLng: position(event) });
    }
  }

  return (
    <div
      className="roof-map-viewport"
      style={{ "--roof-map-ui-scale": 1 / magnification } as CSSProperties}
      ref={viewportRef}
      onPointerDownCapture={pointerDown}
      onPointerMoveCapture={pointerMove}
      onPointerUpCapture={(event) => finish(event)}
      onPointerCancelCapture={(event) => finish(event, true)}
      onLostPointerCapture={(event) => finish(event, true)}
      // Google can also listen to legacy touch events: handle gestures only once.
      onTouchStartCapture={(event) => { if (!isMapChrome(event.target)) event.stopPropagation(); }}
      onTouchMoveCapture={(event) => { if (!isMapChrome(event.target)) event.stopPropagation(); }}
      onTouchEndCapture={(event) => { if (!isMapChrome(event.target)) event.stopPropagation(); }}
      onTouchCancelCapture={(event) => { if (!isMapChrome(event.target)) event.stopPropagation(); }}
      onClickCapture={(event) => {
        if (!isMapChrome(event.target)) { event.preventDefault(); event.stopPropagation(); }
      }}
      onDoubleClickCapture={(event) => {
        if (!isMapChrome(event.target)) { event.preventDefault(); event.stopPropagation(); }
      }}
    >
      <div
        className="google-map-canvas roof-map-canvas"
        ref={canvasRef}
        style={{ width: `${100 / magnification}%`, height: `${100 / magnification}%`, transform: `scale(${magnification})`, transformOrigin: "top left" }}
      />
    </div>
  );
}
