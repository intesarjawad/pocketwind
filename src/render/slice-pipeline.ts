import type { Layout } from '../geometry/voxel-grid';
import { U_LU } from '../lbm/units';
import { COLOR_MAPS, COLOR_STOPS, type SliceField } from './colormap';
import { DEPTH_FORMAT, parseRenderColor } from './frame';
import frameShader from './shaders/frame.wgsl?raw';
import sliceShader from './shaders/slice.wgsl?raw';

declare const GPUBufferUsage: { readonly UNIFORM: number; readonly COPY_DST: number };
declare const GPUTextureUsage: {
  readonly STORAGE_BINDING: number;
  readonly TEXTURE_BINDING: number;
  readonly COPY_SRC: number;
};

export const SLICE_PARAMS_BYTES = 32 + COLOR_STOPS * 16;
const WORKGROUP = 8;

/** The plane is normal to y, so the texture is nx by nz and texel (x, z) is lattice node (x, plane, z). */
export function packSliceParams(grid: Layout, plane: number, field: SliceField): ArrayBuffer {
  if (
    ![grid.nx, grid.ny, grid.nz].every((v) => Number.isSafeInteger(v) && v >= 2) ||
    !Number.isSafeInteger(plane) ||
    plane < 0 ||
    plane >= grid.ny
  ) {
    throw new RangeError('The slice plane must be a y index inside a grid of at least two cells.');
  }
  const map = COLOR_MAPS[field];
  const buffer = new ArrayBuffer(SLICE_PARAMS_BYTES);
  new Uint32Array(buffer).set([grid.nx, grid.ny, grid.nz, plane, field === 'speed' ? 0 : 1]);
  const floats = new Float32Array(buffer);
  floats.set([U_LU, map.low, map.high], 5);
  map.stops.forEach((stop, index) => {
    floats.set(parseRenderColor(stop, [0, 0, 0, 1]), 8 + index * 4);
  });
  return buffer;
}

export type SliceKeyAction = 'toggle' | 'switch';
type SliceKey = Pick<KeyboardEvent, 'code' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>;

/** Match the physical key so Caps Lock never turns a toggle into a field switch. */
export function sliceKeyAction(event: SliceKey): SliceKeyAction | undefined {
  if (event.code !== 'KeyS' || event.altKey || event.ctrlKey || event.metaKey) return undefined;
  return event.shiftKey ? 'switch' : 'toggle';
}

export function attachSliceKeys(
  canvas: HTMLElement,
  onAction: (action: SliceKeyAction) => void,
): () => void {
  const listener = (event: KeyboardEvent): void => {
    const action = sliceKeyAction(event);
    if (!action || event.repeat) return;
    event.preventDefault();
    onAction(action);
  };
  canvas.addEventListener('keydown', listener);
  return () => canvas.removeEventListener('keydown', listener);
}

export interface SliceOptions {
  readonly grid: Layout;
  readonly macroBuffer: GPUBuffer;
  readonly plane?: number;
  readonly field?: SliceField;
}

/** Borrow the macro field; the r32float texture holds the scalar so it can be read back exactly. */
export async function createSlicePipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  frame: GPUBuffer,
  options: SliceOptions,
) {
  const { grid, macroBuffer } = options;
  const plane = options.plane ?? Math.floor(grid.ny / 2);
  let field: SliceField = options.field ?? 'speed';
  let visible = true;
  const initial = packSliceParams(grid, plane, field);
  const module = device.createShaderModule({
    label: 'Slice plane',
    code: `${frameShader}\n${sliceShader}`,
  });
  const compute = await device.createComputePipelineAsync({
    label: 'Slice values',
    layout: 'auto',
    compute: { module, entryPoint: 'evaluate' },
  });
  const pipeline = await device.createRenderPipelineAsync({
    label: 'Slice plane',
    layout: 'auto',
    vertex: { module, entryPoint: 'vertex' },
    fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
  });
  const params = device.createBuffer({
    label: 'Slice parameters',
    size: SLICE_PARAMS_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const values = device.createTexture({
    label: 'Slice values',
    size: [grid.nx, grid.nz],
    format: 'r32float',
    usage:
      GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
  });
  device.queue.writeBuffer(params, 0, initial);
  const view = values.createView();
  const computeGroup = device.createBindGroup({
    layout: compute.getBindGroupLayout(0),
    entries: [
      { binding: 1, resource: { buffer: params } },
      { binding: 3, resource: { buffer: macroBuffer } },
      { binding: 4, resource: view },
    ],
  });
  const drawGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frame } },
      { binding: 1, resource: { buffer: params } },
      { binding: 2, resource: view },
    ],
  });
  return {
    texture: values,
    get field(): SliceField {
      return field;
    },
    get visible(): boolean {
      return visible;
    },
    setField(next: SliceField): void {
      field = next;
      device.queue.writeBuffer(params, 0, packSliceParams(grid, plane, field));
    },
    switchField(): SliceField {
      this.setField(field === 'speed' ? 'cp' : 'speed');
      return field;
    },
    toggle(): boolean {
      visible = !visible;
      return visible;
    },
    /** Encode after the solver's final macro write so the texture matches the drawn frame. */
    update(encoder: GPUCommandEncoder): void {
      if (!visible) return;
      const pass = encoder.beginComputePass({ label: 'Slice values' });
      pass.setPipeline(compute);
      pass.setBindGroup(0, computeGroup);
      pass.dispatchWorkgroups(Math.ceil(grid.nx / WORKGROUP), Math.ceil(grid.nz / WORKGROUP));
      pass.end();
    },
    draw(pass: GPURenderPassEncoder): void {
      if (!visible) return;
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, drawGroup);
      pass.draw(6);
    },
    destroy(): void {
      params.destroy();
      values.destroy();
    },
  };
}
