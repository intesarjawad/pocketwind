import { mat4 } from 'wgpu-matrix';

export type Point3 = readonly [number, number, number];
export type CameraPreset = 'front' | 'side' | 'top' | 'rearquarter';

const FIELD_OF_VIEW_RAD = Math.PI / 4;
const PITCH_LIMIT_RAD = Math.PI / 2 - 0.001;
const POINTER_RADIANS_PER_PIXEL = 0.005;
const KEY_STEP_RAD = Math.PI / 36;
const ZOOM_PER_PIXEL = 0.001;
const WHEEL_LINE_PIXELS = 16;

const PRESETS: Record<CameraPreset, readonly [number, number]> = {
  front: [Math.PI, 0],
  side: [-Math.PI / 2, 0],
  top: [-Math.PI / 2, PITCH_LIMIT_RAD],
  rearquarter: [-Math.PI / 4, Math.PI / 6],
};

/** Unknown or absent hash values use the overview without changing the URL. */
export function cameraPresetFromHash(hash: string): CameraPreset {
  const name = new URLSearchParams(hash.split('?')[1] ?? hash.replace(/^#/, '')).get('cam');
  return name === 'front' || name === 'side' || name === 'top' || name === 'rearquarter'
    ? name
    : 'rearquarter';
}

/** +x is downstream, +z is up; front looks downstream from the inlet.
 * Pitch stops short of the poles so the z-up view matrix stays nonsingular.
 * Distance and clipping scale with the domain's bounding sphere.
 */
export class OrbitCamera {
  yawRad: number;
  pitchRad: number;
  distance: number;

  constructor(
    readonly preset: CameraPreset = 'rearquarter',
    readonly target: Point3 = [0, 0, 0],
    readonly radius = 1,
  ) {
    if (!Number.isFinite(radius) || radius <= 0 || !target.every(Number.isFinite)) {
      throw new Error('Camera target must be finite and domain radius must be positive.');
    }
    [this.yawRad, this.pitchRad] = PRESETS[preset];
    // Leave a 15% margin around the bounding sphere at the narrower field of view.
    this.distance = (radius / Math.sin(FIELD_OF_VIEW_RAD / 2)) * 1.15;
  }

  reset(): void {
    [this.yawRad, this.pitchRad] = PRESETS[this.preset];
    this.distance = (this.radius / Math.sin(FIELD_OF_VIEW_RAD / 2)) * 1.15;
  }

  orbit(yawDeltaRad: number, pitchDeltaRad: number): void {
    const fullTurn = 2 * Math.PI;
    this.yawRad = (((this.yawRad + yawDeltaRad) % fullTurn) + fullTurn) % fullTurn;
    this.pitchRad = Math.max(
      -PITCH_LIMIT_RAD,
      Math.min(PITCH_LIMIT_RAD, this.pitchRad + pitchDeltaRad),
    );
  }

  zoom(deltaPixels: number): void {
    this.distance = Math.max(
      this.radius * 1.05,
      Math.min(this.radius * 20, this.distance * Math.exp(deltaPixels * ZOOM_PER_PIXEL)),
    );
  }

  get eye(): Point3 {
    const horizontal = this.distance * Math.cos(this.pitchRad);
    return [
      this.target[0] + horizontal * Math.cos(this.yawRad),
      this.target[1] + horizontal * Math.sin(this.yawRad),
      this.target[2] + this.distance * Math.sin(this.pitchRad),
    ];
  }

  /** WebGPU uses zero-to-one depth; preserve framing in portrait canvases. */
  viewProjection(aspect: number): Float32Array<ArrayBuffer> {
    if (!Number.isFinite(aspect) || aspect <= 0) {
      throw new Error('Camera aspect ratio must be positive and finite.');
    }
    const fov = 2 * Math.atan(Math.tan(FIELD_OF_VIEW_RAD / 2) / Math.min(1, aspect));
    const projection = mat4.perspective(fov, aspect, this.radius / 100, this.radius * 100);
    const view = mat4.lookAt(this.eye, this.target, [0, 0, 1]);
    return mat4.multiply(projection, view, new Float32Array(16));
  }
}

/** Bind controls only to the focused canvas; return complete listener cleanup. */
export function attachCameraControls(
  canvas: HTMLCanvasElement,
  camera: OrbitCamera,
  changed: () => void,
  togglePause: () => void,
): () => void {
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  let drag: { id: number; x: number; y: number } | undefined;

  canvas.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 || drag) return;
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      event.preventDefault();
    },
    options,
  );
  canvas.addEventListener(
    'pointermove',
    (event) => {
      if (drag?.id !== event.pointerId) return;
      camera.orbit(
        -(event.clientX - drag.x) * POINTER_RADIANS_PER_PIXEL,
        (event.clientY - drag.y) * POINTER_RADIANS_PER_PIXEL,
      );
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      changed();
    },
    options,
  );
  const endDrag = (event: PointerEvent): void => {
    if (drag?.id !== event.pointerId) return;
    drag = undefined;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener('pointerup', endDrag, options);
  canvas.addEventListener('pointercancel', endDrag, options);
  canvas.addEventListener('lostpointercapture', endDrag, options);
  canvas.addEventListener(
    'wheel',
    (event) => {
      const pixels =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? WHEEL_LINE_PIXELS
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? canvas.clientHeight
            : 1;
      camera.zoom(event.deltaY * pixels);
      changed();
      event.preventDefault();
    },
    { ...options, passive: false },
  );
  canvas.addEventListener(
    'keydown',
    (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      switch (event.key) {
        case 'ArrowLeft':
          camera.orbit(-KEY_STEP_RAD, 0);
          break;
        case 'ArrowRight':
          camera.orbit(KEY_STEP_RAD, 0);
          break;
        case 'ArrowUp':
          camera.orbit(0, KEY_STEP_RAD);
          break;
        case 'ArrowDown':
          camera.orbit(0, -KEY_STEP_RAD);
          break;
        case 'r':
        case 'R':
          camera.reset();
          break;
        case ' ':
          if (!event.repeat) togglePause();
          break;
        default:
          return;
      }
      event.preventDefault();
      changed();
    },
    options,
  );

  return () => {
    if (drag && canvas.hasPointerCapture(drag.id)) canvas.releasePointerCapture(drag.id);
    listeners.abort();
  };
}
