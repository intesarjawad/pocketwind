import { dispatch2D } from '../gpu/dispatch';
import { U_LU } from '../lbm/units';
import { readRenderColors } from './frame';
import type { DomainBounds } from './lines-pipeline';
import type { ParticleGrid } from './particle-layout';
import {
  dyePorts,
  fitPlate,
  type PlateFrame,
  packSmokeParams,
  plateToCss,
  RAKE_THREADS,
  RAKE_X,
  RELEASE_EVERY_FRAMES,
  RING_SLOTS,
  rakeSpan,
  SMOKE_PARAMS_BYTES,
  smokeFront,
  TEAR_CELLS,
  THREADS,
} from './plate-layout';
import bodyShader from './shaders/plate_body.wgsl?raw';
import postShader from './shaders/plate_post.wgsl?raw';
import smokeShader from './shaders/plate_smoke.wgsl?raw';
import threadShader from './shaders/plate_threads.wgsl?raw';

declare const GPUBufferUsage: {
  readonly STORAGE: number;
  readonly UNIFORM: number;
  readonly VERTEX: number;
  readonly COPY_DST: number;
  readonly COPY_SRC: number;
  readonly MAP_READ: number;
};
declare const GPUMapMode: { readonly READ: number };
declare const GPUTextureUsage: {
  readonly RENDER_ATTACHMENT: number;
  readonly TEXTURE_BINDING: number;
};

/** The smoke front at one instant, already placed in CSS pixels on the canvas. */
export type Exposure = {
  readonly step: number;
  readonly points: readonly (readonly [number, number])[];
  /** The clear band above the rake, in CSS pixels, where the exposure is labelled. */
  readonly band: number;
  /**
   * Once the flow has developed, on the last exposure only: a point on the body's
   * underside and one in the gap below it, three fifths of the body back from the nose,
   * where the smoke under it comes to rest, and the air's speed there as a fraction of
   * the free stream, read from the solver.
   */
  readonly gap?: {
    readonly under: readonly [number, number];
    readonly below: readonly [number, number];
    readonly speed: number;
  };
};

export type PlateOptions = {
  readonly grid: ParticleGrid;
  readonly macroBuffer: GPUBuffer;
  /** The placed body and its stilts, in cell coordinates. */
  readonly body: Float32Array;
  readonly supports: Float32Array | null;
  readonly bodyBounds: DomainBounds;
  readonly label: string;
  /** Render one developed frame instead of a moving plate. */
  readonly still: boolean;
  readonly flowThroughSteps: number;
  /** Encode solver steps and the final macro write; return the step count. */
  readonly advance: (encoder: GPUCommandEncoder) => number;
  readonly onExposure?: (exposure: Exposure) => void;
  readonly onSmoke?: () => void;
  readonly signal?: AbortSignal;
};

const MAX_PIXEL_RATIO = 2;
// Phones hold 60 fps only at one device pixel per CSS pixel; the threads stay a pixel wide.
const TOUCH_PIXEL_RATIO = 1;
const LIGHT_FORMAT: GPUTextureFormat = 'rgba16float';
const MASK_FORMAT: GPUTextureFormat = 'rg8unorm';
const VIEW_BYTES = 96;
const POST_BYTES = 80;
// The masthead sits on the plate, so the plate darkens to its ground behind it. The fade
// is part of the image, so a saved card matches the screen.
const TOP_FADE_PX = 112;
// Frames that present wait on the swap chain; frames that only compute (an off-screen or
// still plate) would otherwise queue GPU work faster than it runs and starve readbacks.
const MAX_FRAMES_IN_FLIGHT = 2;
const MAP_BYTES = 32;
// Fronts are kept where the free stream would carry them past the nose, mid-body and the base.
const EXPOSURE_FRACTIONS = [0.12, 0.55, 1.05] as const;
// A reduced-motion plate is shown once the smoke has had this many flow-throughs to
// develop: enough for the dye behind the base to roll into its spiral.
const STILL_FLOW_THROUGHS = 6;
// The front of each thread fades over this many CSS pixels, so it ends in smoke, not a stub.
const TIP_FADE_PX = 60;

type Targets = {
  readonly width: number;
  readonly height: number;
  readonly frame: PlateFrame;
  readonly textures: GPUTexture[];
  readonly light: GPUTextureView;
  readonly halfA: GPUTextureView;
  readonly halfB: GPUTextureView;
  readonly maskSamples: GPUTextureView;
  readonly mask: GPUTextureView;
  readonly blurX: GPUBindGroup;
  readonly blurY: GPUBindGroup;
  readonly compose: [GPUBindGroup, GPUBindGroup];
  bodyDrawn: boolean;
};

function cssSize(canvas: HTMLCanvasElement): { width: number; height: number } {
  return { width: Math.max(1, canvas.clientWidth), height: Math.max(1, canvas.clientHeight) };
}

/** Mount the smoke plate on the canvas with the solver's device; disposal keeps the device. */
export async function createPlate(
  canvas: HTMLCanvasElement,
  device: GPUDevice,
  options: PlateOptions,
): Promise<{
  dispose: () => void;
  readonly format: GPUTextureFormat;
  drawInto: (target: GPUTexture, size: { width: number; height: number }) => void;
}> {
  const { grid } = options;
  const canvasContext = canvas.getContext('webgpu');
  if (!canvasContext) throw new Error('The tunnel canvas could not create a WebGPU context.');
  const context = canvasContext;
  const format = navigator.gpu.getPreferredCanvasFormat();
  const colors = readRenderColors(canvas);
  const plane = Math.min(
    grid.ny - 1,
    Math.max(0, Math.round((options.bodyBounds.min[1] + options.bodyBounds.max[1]) / 2)),
  );
  const buffers: GPUBuffer[] = [];
  const allocate = (label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
    const buffer = device.createBuffer({ label, size, usage });
    buffers.push(buffer);
    return buffer;
  };

  const smokeModule = device.createShaderModule({ label: 'Plate smoke', code: smokeShader });
  const threadModule = device.createShaderModule({ label: 'Plate threads', code: threadShader });
  const bodyModule = device.createShaderModule({ label: 'Plate body', code: bodyShader });
  const postModule = device.createShaderModule({ label: 'Plate post', code: postShader });
  // Threads keep the brightest light at each pixel rather than summing it: smoke that
  // retraces itself in an eddy, or piles against a wall, stays one tube bright, not a speck.
  const brightest: GPUBlendState = {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
  };
  const halation = (entryPoint: 'blurX' | 'blurY'): Promise<GPURenderPipeline> =>
    device.createRenderPipelineAsync({
      label: `Plate ${entryPoint}`,
      layout: 'auto',
      vertex: { module: postModule, entryPoint: 'vertex' },
      fragment: { module: postModule, entryPoint, targets: [{ format: LIGHT_FORMAT }] },
    });
  const [advect, threads, body, blurX, blurY, compose] = await Promise.all([
    device.createComputePipelineAsync({
      label: 'Plate smoke',
      layout: 'auto',
      compute: { module: smokeModule, entryPoint: 'main' },
    }),
    device.createRenderPipelineAsync({
      label: 'Plate threads',
      layout: 'auto',
      vertex: { module: threadModule, entryPoint: 'vertex' },
      fragment: {
        module: threadModule,
        entryPoint: 'fragment',
        targets: [{ format: LIGHT_FORMAT, blend: brightest }],
      },
    }),
    device.createRenderPipelineAsync({
      label: 'Plate body',
      layout: 'auto',
      vertex: {
        module: bodyModule,
        entryPoint: 'vertex',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        ],
      },
      fragment: {
        module: bodyModule,
        entryPoint: 'fragment',
        targets: [
          {
            format: MASK_FORMAT,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
              alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
            },
          },
        ],
      },
      multisample: { count: 4 },
    }),
    halation('blurX'),
    halation('blurY'),
    device.createRenderPipelineAsync({
      label: 'Plate compose',
      layout: 'auto',
      vertex: { module: postModule, entryPoint: 'vertex' },
      fragment: { module: postModule, entryPoint: 'compose', targets: [{ format }] },
    }),
  ]);
  options.signal?.throwIfAborted();

  let targets: Targets | undefined;
  try {
    const smoke = allocate(
      'Plate smoke puffs',
      THREADS * RING_SLOTS * 16,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    );
    const flags = grid.geometry.subarray(0, grid.nx * grid.ny * grid.nz);
    const portCells = dyePorts(flags, grid, plane, [
      options.bodyBounds.min[2],
      options.bodyBounds.max[2],
    ]);
    const ports = allocate(
      'Plate dye ports',
      portCells.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    device.queue.writeBuffer(ports, 0, portCells);
    const geometry = allocate(
      'Plate cell flags',
      flags.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    device.queue.writeBuffer(geometry, 0, flags);
    const smokeParams = allocate(
      'Plate smoke parameters',
      SMOKE_PARAMS_BYTES,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    const view = allocate(
      'Plate view',
      VIEW_BYTES,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    const post = allocate(
      'Plate post',
      POST_BYTES,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    const map = allocate(
      'Plate body map',
      MAP_BYTES,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    const parts = [options.body, options.supports].map((positions, index) => {
      if (positions === null || positions.length < 9) return null;
      const buffer = allocate(
        `Plate ${index === 0 ? 'body' : 'stilt'} vertices`,
        positions.byteLength,
        GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      );
      device.queue.writeBuffer(buffer, 0, positions as Float32Array<ArrayBuffer>);
      return { buffer, count: Math.floor(positions.length / 3), part: index };
    });
    const front = allocate(
      'Plate smoke front readback',
      RAKE_THREADS * 16,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    );
    const { min: bodyMin, max: bodyMax } = options.bodyBounds;
    const gapX = bodyMin[0] + 0.6 * (bodyMax[0] - bodyMin[0]);
    const gapZ = 0.5 * bodyMin[2];
    const gapCell = Math.round(gapX) + grid.nx * (plane + grid.ny * Math.max(1, Math.round(gapZ)));
    const gapProbe = allocate(
      'Plate gap speed readback',
      16,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    );
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const advectGroup = device.createBindGroup({
      layout: advect.getBindGroupLayout(0),
      entries: [smokeParams, smoke, options.macroBuffer, geometry, ports].map(
        (buffer, binding) => ({
          binding,
          resource: { buffer },
        }),
      ),
    });
    const threadGroup = device.createBindGroup({
      layout: threads.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: view } },
        { binding: 1, resource: { buffer: smoke } },
      ],
    });
    const bodyGroup = device.createBindGroup({
      layout: body.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: map } }],
    });
    const dispatch = dispatch2D(
      THREADS * RING_SLOTS,
      64,
      device.limits.maxComputeWorkgroupsPerDimension,
    );
    context.configure({ device, format, alphaMode: 'opaque' });

    let completeBody = false;
    const embed = new URLSearchParams(location.hash.split('?')[1] ?? '').get('embed') === '1';
    function createTargets(width: number, height: number, ratio: number): Targets {
      const textures: GPUTexture[] = [];
      const texture = (
        label: string,
        w: number,
        h: number,
        textureFormat: GPUTextureFormat,
        sampleCount = 1,
      ): GPUTextureView => {
        const created = device.createTexture({
          label,
          size: [Math.max(1, w), Math.max(1, h)],
          format: textureFormat,
          sampleCount,
          usage:
            sampleCount > 1
              ? GPUTextureUsage.RENDER_ATTACHMENT
              : GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        textures.push(created);
        return created.createView();
      };
      const halfWidth = Math.ceil(width / 2);
      const halfHeight = Math.ceil(height / 2);
      const light = texture('Plate light', width, height, LIGHT_FORMAT);
      const halfA = texture('Plate halation across', halfWidth, halfHeight, LIGHT_FORMAT);
      const halfB = texture('Plate halation', halfWidth, halfHeight, LIGHT_FORMAT);
      const maskSamples = texture('Plate body samples', width, height, MASK_FORMAT, 4);
      const mask = texture('Plate body', width, height, MASK_FORMAT);
      const blurGroup = (pipeline: GPURenderPipeline, source: GPUTextureView): GPUBindGroup =>
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 1, resource: source },
            { binding: 2, resource: sampler },
          ],
        });
      const css = { width: width / ratio, height: height / ratio };
      return {
        width,
        height,
        frame: fitPlate(
          css,
          grid,
          options.bodyBounds,
          embed ? 'embed' : completeBody ? 'complete' : 'default',
        ),
        textures,
        light,
        halfA,
        halfB,
        maskSamples,
        mask,
        blurX: blurGroup(blurX, light),
        blurY: blurGroup(blurY, halfA),
        compose: [
          device.createBindGroup({
            layout: compose.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: post } },
              { binding: 1, resource: halfB },
              { binding: 2, resource: sampler },
            ],
          }),
          device.createBindGroup({
            layout: compose.getBindGroupLayout(1),
            entries: [
              { binding: 0, resource: light },
              { binding: 1, resource: mask },
            ],
          }),
        ],
        bodyDrawn: false,
      };
    }

    function destroyTargets(set: Targets | undefined): void {
      for (const texture of set?.textures ?? []) texture.destroy();
    }

    let release = 0;
    let frames = 0;
    let steps = 0;
    let exposureIndex = 0;
    let reading = false;
    let gapSpeed: number | 'pending' | undefined;
    let disposed = false;
    let paused = false;
    let visible = true;
    let still: 'none' | 'bare' | 'developed' = 'none';
    let frame: number | undefined;
    let inFlight = 0;
    const exposures: { step: number; cells: (readonly [number, number])[] }[] = [];
    const touch = window.matchMedia('(pointer: coarse)');
    const ratio = (): number =>
      Math.min(window.devicePixelRatio || 1, touch.matches ? TOUCH_PIXEL_RATIO : MAX_PIXEL_RATIO);
    const exposureSteps = EXPOSURE_FRACTIONS.map(
      (fraction) =>
        (options.bodyBounds.min[0] +
          fraction * (options.bodyBounds.max[0] - options.bodyBounds.min[0]) -
          RAKE_X) /
        U_LU,
    );

    function writeUniforms(set: Targets, pixelRatio: number): void {
      const { frame: fitted, width, height } = set;
      const scale = fitted.scale * pixelRatio;
      const originX = fitted.originX * pixelRatio;
      const groundY = fitted.groundY * pixelRatio;
      // A phone draws every other rake thread, so the tubes stay round instead of
      // packing into moiré. A tube 40% as wide as the drawn spacing leaves dark between.
      const stride = fitted.compact ? 2 : 1;
      const [low, high] = rakeSpan(fitted, grid);
      const radius = Math.max(1, 0.2 * stride * ((high - low) / (RAKE_THREADS - 1)) * scale);
      const lampX = 0.24 * width;
      const lampY = 0.04 * height;
      const viewData = new ArrayBuffer(VIEW_BYTES);
      const floats = new Float32Array(viewData);
      floats.set([
        scale,
        originX,
        groundY,
        TIP_FADE_PX * pixelRatio,
        width,
        height,
        radius,
        U_LU * RELEASE_EVERY_FRAMES * 8,
      ]);
      new Uint32Array(viewData).set(
        [THREADS, RING_SLOTS, Math.max(0, release - 1), RAKE_THREADS],
        8,
      );
      floats.set([lampX, lampY, 0.9 * width, TEAR_CELLS, ...colors.smoke], 12);
      floats[19] = options.flowThroughSteps / (RELEASE_EVERY_FRAMES * 8);
      floats[20] = bodyMax[0];
      floats[21] = stride;
      device.queue.writeBuffer(view, 0, viewData);
      device.queue.writeBuffer(
        map,
        0,
        new Float32Array([scale, originX, groundY, 0, width, height, 0, 0]),
      );
      device.queue.writeBuffer(
        post,
        0,
        new Float32Array([
          width,
          height,
          groundY,
          17,
          lampX,
          lampY,
          0.8 * width,
          0.3,
          ...colors.ground.slice(0, 3),
          TOP_FADE_PX * pixelRatio,
          ...colors.smoke,
          ...colors.body,
        ]),
      );
    }

    function encodeView(encoder: GPUCommandEncoder, set: Targets, target: GPUTextureView): void {
      if (!set.bodyDrawn) {
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: set.maskSamples,
              resolveTarget: set.mask,
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: 'clear',
              storeOp: 'discard',
            },
          ],
        });
        pass.setPipeline(body);
        pass.setBindGroup(0, bodyGroup);
        for (const part of parts) {
          if (part === null) continue;
          pass.setVertexBuffer(0, part.buffer);
          pass.draw(part.count, 1, 0, part.part);
        }
        pass.end();
        set.bodyDrawn = true;
      }
      const pass = (
        view: GPUTextureView,
        pipeline: GPURenderPipeline,
        groups: GPUBindGroup[],
        count: number,
        instances = 1,
      ): void => {
        const encoded = encoder.beginRenderPass({
          colorAttachments: [
            { view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
          ],
        });
        encoded.setPipeline(pipeline);
        for (const [index, group] of groups.entries()) encoded.setBindGroup(index, group);
        if (instances > 0) encoded.draw(count, instances);
        encoded.end();
      };
      pass(set.light, threads, [threadGroup], 6 * (RING_SLOTS - 1), release > 1 ? THREADS : 0);
      pass(set.halfA, blurX, [set.blurX], 3);
      pass(set.halfB, blurY, [set.blurY], 3);
      pass(target, compose, set.compose, 3);
    }

    function advanceSmoke(encoder: GPUCommandEncoder): void {
      const taken = options.advance(encoder);
      const releasing = frames % RELEASE_EVERY_FRAMES === 0;
      device.queue.writeBuffer(
        smokeParams,
        0,
        packSmokeParams({
          grid,
          plane,
          release,
          releasing,
          steps: taken,
          rake: rakeSpan(
            targets?.frame ?? fitPlate(cssSize(canvas), grid, options.bodyBounds),
            grid,
          ),
        }),
      );
      const compute = encoder.beginComputePass({ label: 'Plate smoke' });
      compute.setPipeline(advect);
      compute.setBindGroup(0, advectGroup);
      compute.dispatchWorkgroups(...dispatch);
      compute.end();
      if (releasing) release += 1;
      frames += 1;
      steps += taken;
    }

    /** Copy the first puff of every thread, the smoke front, and keep it as an exposure. */
    function encodeExposure(encoder: GPUCommandEncoder): number | undefined {
      const due = exposureSteps[exposureIndex];
      if (reading || due === undefined || steps < due) return undefined;
      for (let thread = 0; thread < RAKE_THREADS; thread += 1) {
        encoder.copyBufferToBuffer(smoke, thread * RING_SLOTS * 16, front, thread * 16, 16);
      }
      exposureIndex += 1;
      return steps;
    }

    function readExposure(step: number): void {
      reading = true;
      void front
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          if (disposed) return;
          const records = new Float32Array(front.getMappedRange().slice(0));
          front.unmap();
          const cells = smokeFront(records);
          if (cells.length === 0) return;
          if (exposures.length === 0) options.onSmoke?.();
          exposures.push({ step, cells });
          emitExposures();
        })
        .catch(() => {
          // Device loss is reported through the device; a missed exposure is only a missing line.
        })
        .finally(() => {
          reading = false;
        });
    }

    function emitExposures(): void {
      const fitted = targets?.frame;
      if (!fitted) return;
      for (const [index, exposure] of exposures.entries()) {
        const last = index === EXPOSURE_FRACTIONS.length - 1;
        options.onExposure?.({
          step: exposure.step,
          points: exposure.cells.map(([x, z]) => plateToCss(fitted, x, z)),
          band: plateToCss(fitted, 0, fitted.zTop)[1],
          ...(last &&
            typeof gapSpeed === 'number' && {
              gap: {
                under: plateToCss(fitted, gapX, bodyMin[2]),
                below: plateToCss(fitted, gapX, gapZ),
                speed: gapSpeed,
              },
            }),
        });
      }
    }

    /** Once the flow has developed, sample the air's speed in the gap under the body. */
    function encodeGapProbe(encoder: GPUCommandEncoder): boolean {
      if (gapSpeed !== undefined || steps < STILL_FLOW_THROUGHS * options.flowThroughSteps) {
        return false;
      }
      encoder.copyBufferToBuffer(options.macroBuffer, gapCell * 16, gapProbe, 0, 16);
      gapSpeed = 'pending';
      return true;
    }

    function readGapProbe(): void {
      void gapProbe
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          if (disposed) return;
          const [, ux = 0, , uz = 0] = new Float32Array(gapProbe.getMappedRange().slice(0));
          gapProbe.unmap();
          gapSpeed = Math.hypot(ux, uz) / U_LU;
          emitExposures();
        })
        .catch(() => {
          // Device loss is reported through the device; the note is only left out.
        });
    }

    function currentTargets(): Targets {
      const pixelRatio = ratio();
      const { width: cssWidth, height: cssHeight } = cssSize(canvas);
      const limit = device.limits.maxTextureDimension2D;
      const width = Math.min(limit, Math.round(cssWidth * pixelRatio));
      const height = Math.min(limit, Math.round(cssHeight * pixelRatio));
      if (!targets || targets.width !== width || targets.height !== height) {
        destroyTargets(targets);
        canvas.width = width;
        canvas.height = height;
        targets = createTargets(width, height, pixelRatio);
        still = 'none';
        emitExposures();
      }
      return targets;
    }

    function draw(): void {
      frame = undefined;
      if (disposed || document.hidden) return;
      if (inFlight >= MAX_FRAMES_IN_FLIGHT) {
        requestFrame();
        return;
      }
      const set = currentTargets();
      const encoder = device.createCommandEncoder({ label: 'Plate frame' });
      if (!paused) advanceSmoke(encoder);
      const exposureStep = encodeExposure(encoder);
      const probed = encodeGapProbe(encoder);
      present(encoder, set);
      device.queue.submit([encoder.finish()]);
      inFlight += 1;
      void device.queue
        .onSubmittedWorkDone()
        .catch(() => {
          // Device loss is reported through the device.
        })
        .finally(() => {
          inFlight -= 1;
        });
      if (exposureStep !== undefined) readExposure(exposureStep);
      if (probed) readGapProbe();
      updateState();
      if (!paused) requestFrame();
    }

    // A still plate shows the bare body at once, then the developed smoke, and nothing between.
    function present(encoder: GPUCommandEncoder, set: Targets): void {
      const developed = steps >= STILL_FLOW_THROUGHS * options.flowThroughSteps;
      const due = options.still
        ? still === 'none' || (developed && still !== 'developed')
        : visible || !set.bodyDrawn;
      if (!due) return;
      writeUniforms(set, ratio());
      encodeView(encoder, set, context.getCurrentTexture().createView());
      if (options.still) still = developed ? 'developed' : 'bare';
    }

    function requestFrame(): void {
      if (!disposed && !document.hidden && frame === undefined) frame = requestAnimationFrame(draw);
    }

    function updateState(): void {
      canvas.dataset.sceneState = document.hidden ? 'hidden' : paused ? 'paused' : 'running';
      canvas.dataset.plateRelease = String(release);
      const view = paused ? 'view paused' : 'view running';
      const label = `Smoke threads bending around the ${options.label} on its centre plane, ${view}.`;
      // Called every frame; the attribute only changes with the pause state.
      if (canvas.getAttribute('aria-label') !== label) canvas.setAttribute('aria-label', label);
    }

    function drawInto(target: GPUTexture, size: { width: number; height: number }): void {
      const set = createTargets(size.width, size.height, 1);
      try {
        writeUniforms(set, 1);
        const encoder = device.createCommandEncoder({ label: 'Plate still' });
        encodeView(encoder, set, target.createView());
        device.queue.submit([encoder.finish()]);
      } finally {
        destroyTargets(set);
      }
      // The uniforms now describe the still's size; the next frame restores the canvas's.
      if (targets) still = 'none';
      requestFrame();
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== ' ') return;
      event.preventDefault();
      paused = !paused;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      updateState();
      requestFrame();
      if (paused) draw();
    };
    const visibilityChanged = (): void => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      updateState();
      requestFrame();
    };
    const intersection = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
    });
    intersection.observe(canvas);
    const resize = new ResizeObserver(() => {
      if (paused || options.still) draw();
      else requestFrame();
    });
    resize.observe(canvas);
    const fitChanged = (event: Event): void => {
      completeBody = event instanceof CustomEvent && event.detail === true;
      destroyTargets(targets);
      targets = undefined;
      if (paused || options.still) draw();
      else requestFrame();
    };
    document.addEventListener('plate-fit', fitChanged);
    document.addEventListener('visibilitychange', visibilityChanged);
    canvas.addEventListener('keydown', onKey);
    const previousTabIndex = canvas.getAttribute('tabindex');
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-description', 'Space pauses or resumes the flow.');

    function dispose(): void {
      if (disposed) return;
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      intersection.disconnect();
      resize.disconnect();
      document.removeEventListener('plate-fit', fitChanged);
      document.removeEventListener('visibilitychange', visibilityChanged);
      canvas.removeEventListener('keydown', onKey);
      device.removeEventListener('uncapturederror', gpuError);
      destroyTargets(targets);
      for (const buffer of buffers) buffer.destroy();
      context.unconfigure();
      if (previousTabIndex === null) canvas.removeAttribute('tabindex');
      else canvas.setAttribute('tabindex', previousTabIndex);
      canvas.removeAttribute('aria-description');
      canvas.setAttribute('aria-label', 'Wind tunnel view');
      delete canvas.dataset.sceneState;
      delete canvas.dataset.plateRelease;
    }

    function gpuError(event: GPUUncapturedErrorEvent): void {
      dispose();
      canvas.dataset.sceneState = 'error';
      canvas.setAttribute(
        'aria-label',
        `Wind tunnel view unavailable. ${event.error.message} Reload to retry.`,
      );
    }
    device.addEventListener('uncapturederror', gpuError);
    void device.lost.then(() => {
      if (!disposed) dispose();
    });
    updateState();
    requestFrame();
    return { dispose, format, drawInto };
  } catch (error) {
    for (const buffer of buffers) buffer.destroy();
    throw error;
  }
}
