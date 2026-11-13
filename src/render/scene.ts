import { CAMERA_INSTRUCTIONS, describeScene } from '../app/scene-description';
import { createRunMarks } from '../app/timing';
import type { Mesh } from '../geometry/stl';
import { attachCameraControls, type CameraPreset, OrbitCamera } from './camera';
import { particlesDeflected } from './deflection';
import { DEPTH_FORMAT, FRAME_BYTES, packFrame, readRenderColors } from './frame';
import { createLinesPipeline, type DomainBounds } from './lines-pipeline';
import { createMeshPipeline } from './mesh-pipeline';
import { PARTICLE_BYTES } from './particle-layout';
import { createParticles, type ParticleOptions } from './particles';

export type { DomainBounds } from './lines-pipeline';
export interface SceneOptions {
  readonly bounds?: DomainBounds;
  readonly signal?: AbortSignal;
  readonly body?: { readonly mesh: Mesh; readonly label: string };
  readonly flow?: ParticleOptions & {
    /** Encode solver steps and the final macro write; return the step count for advection. */
    readonly advance: (encoder: GPUCommandEncoder) => number;
  };
  readonly gridSpacing?: number;
}

// The DOM declarations include GPU interfaces but omit these runtime bindings.
declare const GPUBufferUsage: {
  readonly UNIFORM: number;
  readonly COPY_DST: number;
  readonly MAP_READ: number;
};
declare const GPUMapMode: { readonly READ: number };
declare const GPUTextureUsage: { readonly RENDER_ATTACHMENT: number };
declare global {
  interface HTMLCanvasElement {
    getContext(contextId: 'webgpu'): GPUCanvasContext | null;
  }
}

const MAX_PIXEL_RATIO = 2;
const UNIT_DOMAIN: DomainBounds = { min: [0, 0, 0], max: [1, 1, 1] };

/** Mount on the static canvas using the app's device; disposal never destroys that device. */
export async function createScene(
  canvas: HTMLCanvasElement,
  device: GPUDevice,
  preset: CameraPreset,
  options: SceneOptions = {},
): Promise<{
  dispose: () => void;
  readonly particleBuffer: GPUBuffer | undefined;
  /** The colour format every pipeline was built for; `drawInto` targets must use it. */
  readonly format: GPUTextureFormat;
  /** Draw the current view once into `target` without advancing the flow. */
  drawInto: (target: GPUTexture, size: { width: number; height: number }) => void;
}> {
  const bounds =
    options.bounds ??
    (options.flow
      ? ({
          min: [0, 0, 0],
          max: [options.flow.grid.nx - 1, options.flow.grid.ny - 1, options.flow.grid.nz - 1],
        } satisfies DomainBounds)
      : UNIT_DOMAIN);
  const { min, max } = bounds;
  const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
  const camera = new OrbitCamera(
    preset,
    [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    radius,
  );
  const canvasContext = canvas.getContext('webgpu');
  if (!canvasContext) throw new Error('The tunnel canvas could not create a WebGPU context.');
  const context = canvasContext;
  const format = navigator.gpu.getPreferredCanvasFormat();
  const colors = readRenderColors(canvas);
  const uniform = device.createBuffer({
    label: 'Camera view projection',
    size: FRAME_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const resources: { destroy(): void }[] = [uniform];
  let lines: Awaited<ReturnType<typeof createLinesPipeline>>;
  let body: Awaited<ReturnType<typeof createMeshPipeline>> | undefined;
  let particles: Awaited<ReturnType<typeof createParticles>> | undefined;
  let deflection:
    | { source: GPUBuffer; staging: GPUBuffer; bytes: number; count: number }
    | undefined;
  try {
    lines = await createLinesPipeline(
      device,
      format,
      uniform,
      bounds,
      options.gridSpacing ?? (max[0] - min[0]) / 16,
    );
    resources.push(lines);
    if (options.body) {
      body = await createMeshPipeline(device, format, uniform, options.body.mesh);
      resources.push(body);
    }
    if (options.flow) {
      particles = await createParticles(device, format, uniform, options.flow);
      resources.push(particles);
      const bytes = options.flow.count * PARTICLE_BYTES;
      const staging = device.createBuffer({
        label: 'Particle deflection readback',
        size: bytes,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      resources.push(staging);
      deflection = { source: particles.buffer, staging, bytes, count: options.flow.count };
    }
    options.signal?.throwIfAborted();
    context.configure({ device, format, alphaMode: 'premultiplied' });
  } catch (error) {
    for (const resource of resources) resource.destroy();
    throw error;
  }
  const previousStyle = canvas.getAttribute('style');
  const previousTabIndex = canvas.getAttribute('tabindex');
  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  canvas.style.aspectRatio = '2 / 1';
  canvas.style.touchAction = 'none';
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-description', CAMERA_INSTRUCTIONS);

  let disposed = false;
  let paused = false;
  let frame: number | undefined;
  let depth: GPUTexture | undefined;
  const marks = createRunMarks();
  let smoke = false;
  let reading = false;

  function encodeDeflectionCopy(encoder: GPUCommandEncoder): typeof deflection {
    if (paused || smoke || reading || !deflection) return undefined;
    encoder.copyBufferToBuffer(deflection.source, 0, deflection.staging, 0, deflection.bytes);
    return deflection;
  }

  /** Read the particles back until one frame shows them bent around the body, then stop. */
  function watchDeflection(probe: NonNullable<typeof deflection>): void {
    reading = true;
    void probe.staging
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        if (disposed) return;
        const records = new Float32Array(probe.staging.getMappedRange().slice(0));
        probe.staging.unmap();
        if (!particlesDeflected(records, probe.count)) return;
        smoke = true;
        marks.smoke();
      })
      .catch(() => {
        // Device loss is reported by the scene; a missed probe only delays the mark.
      })
      .finally(() => {
        reading = false;
      });
  }

  function updateDescription(): void {
    const contents = [options.body?.label, options.flow ? 'flow particles' : undefined]
      .filter(Boolean)
      .join(', ');
    canvas.setAttribute(
      'aria-label',
      contents
        ? `Wind tunnel, ${contents}, domain outline and floor grid, view ${paused ? 'paused' : 'ready'}.`
        : describeScene(paused),
    );
    canvas.dataset.sceneState = document.hidden ? 'hidden' : paused ? 'paused' : 'running';
  }

  function requestFrame(): void {
    if (!disposed && !document.hidden && frame === undefined) frame = requestAnimationFrame(draw);
  }

  function writeCamera(aspect: number): void {
    device.queue.writeBuffer(
      uniform,
      0,
      packFrame(camera.viewProjection(aspect), camera.eye, colors),
    );
  }

  function encodeView(
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    depthTarget: GPUTextureView,
  ): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target,
          clearValue: {
            r: colors.ground[0],
            g: colors.ground[1],
            b: colors.ground[2],
            a: colors.ground[3],
          },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depthTarget,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    body?.draw(pass);
    particles?.draw(pass);
    lines.draw(pass);
    pass.end();
  }

  function drawInto(target: GPUTexture, size: { width: number; height: number }): void {
    const targetDepth = device.createTexture({
      label: 'Still frame depth',
      size: [size.width, size.height],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    try {
      writeCamera(size.width / size.height);
      const encoder = device.createCommandEncoder({ label: 'Still frame' });
      encodeView(encoder, target.createView(), targetDepth.createView());
      device.queue.submit([encoder.finish()]);
    } finally {
      targetDepth.destroy();
    }
    // The camera uniform now holds the still's aspect ratio; the next frame restores the canvas's.
    requestFrame();
  }

  function draw(): void {
    frame = undefined;
    if (disposed || document.hidden) return;
    const pixelRatio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
    const width = Math.max(
      1,
      Math.min(device.limits.maxTextureDimension2D, Math.round(canvas.clientWidth * pixelRatio)),
    );
    const height = Math.max(
      1,
      Math.min(device.limits.maxTextureDimension2D, Math.round(canvas.clientHeight * pixelRatio)),
    );
    if (!depth || canvas.width !== width || canvas.height !== height) {
      depth?.destroy();
      canvas.width = width;
      canvas.height = height;
      depth = device.createTexture({
        label: 'Scene depth',
        size: [width, height],
        format: DEPTH_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    writeCamera(width / height);
    const encoder = device.createCommandEncoder({ label: 'Scene frame' });
    if (!paused && options.flow && particles)
      particles.update(encoder, options.flow.advance(encoder));
    const probe = encodeDeflectionCopy(encoder);
    encodeView(encoder, context.getCurrentTexture().createView(), depth.createView());
    device.queue.submit([encoder.finish()]);
    if (probe) watchDeflection(probe);
    if (!paused) requestFrame();
  }

  const removeControls = attachCameraControls(canvas, camera, requestFrame, () => {
    paused = !paused;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    updateDescription();
  });
  const visibilityChanged = (): void => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    updateDescription();
    requestFrame();
  };
  document.addEventListener('visibilitychange', visibilityChanged);
  const observer = new ResizeObserver(requestFrame);
  observer.observe(canvas);

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    removeControls();
    observer.disconnect();
    document.removeEventListener('visibilitychange', visibilityChanged);
    device.removeEventListener('uncapturederror', gpuError);
    depth?.destroy();
    for (const resource of resources) resource.destroy();
    context.unconfigure();
    if (previousStyle === null) canvas.removeAttribute('style');
    else canvas.setAttribute('style', previousStyle);
    if (previousTabIndex === null) canvas.removeAttribute('tabindex');
    else canvas.setAttribute('tabindex', previousTabIndex);
    canvas.removeAttribute('aria-description');
    canvas.setAttribute('aria-label', 'Wind tunnel view');
    delete canvas.dataset.sceneState;
  }

  function fail(message: string): void {
    dispose();
    canvas.dataset.sceneState = 'error';
    canvas.setAttribute('aria-label', `Wind tunnel view unavailable. ${message} Reload to retry.`);
  }
  function gpuError(event: GPUUncapturedErrorEvent): void {
    fail(event.error.message);
  }
  device.addEventListener('uncapturederror', gpuError);
  void device.lost.then((info) => {
    if (!disposed) fail(info.message || 'The graphics device was lost.');
  });
  updateDescription();
  requestFrame();
  return { dispose, particleBuffer: particles?.buffer, format, drawInto };
}
