import { describe, expect, it } from 'vitest';
import { vec4 } from 'wgpu-matrix';
import { CAMERA_INSTRUCTIONS, describeScene } from '../../../src/app/scene-description';
import { cameraPresetFromHash, OrbitCamera, type Point3 } from '../../../src/render/camera';

function project(camera: OrbitCamera, point: Point3, aspect = 2): [number, number, number] {
  const [x, y, z, w] = vec4.transformMat4([...point, 1], camera.viewProjection(aspect));
  if (x === undefined || y === undefined || z === undefined || w === undefined) {
    throw new Error('Projection must return four components.');
  }
  return [x / w, y / w, z / w];
}

describe('orbit camera', () => {
  it.each(['front', 'side', 'top', 'rearquarter'] as const)(
    'reads the %s hash preset',
    (preset) => {
      expect(cameraPresetFromHash(`#/?cam=${preset}`)).toBe(preset);
      expect(cameraPresetFromHash(`#cam=${preset}`)).toBe(preset);
    },
  );

  it.each(['', '#/', '#/validate', '#/?cam=unknown', '#/?other=top'])(
    'defaults %s to the overview',
    (hash) => {
      expect(cameraPresetFromHash(hash)).toBe('rearquarter');
    },
  );

  it('places front upstream, side across the flow and top above the target', () => {
    const front = new OrbitCamera('front');
    expect(front.eye[0]).toBeCloseTo(-front.distance);
    expect(front.eye[1]).toBeCloseTo(0);
    const side = new OrbitCamera('side');
    expect(side.eye[1]).toBeCloseTo(-side.distance);
    expect(side.eye[0]).toBeCloseTo(0);
    const top = new OrbitCamera('top');
    expect(top.eye[2]).toBeCloseTo(top.distance, 4);
    const rear = new OrbitCamera('rearquarter');
    expect(rear.eye[0]).toBeGreaterThan(0);
    expect(rear.eye[1]).toBeLessThan(0);
    expect(rear.eye[2]).toBeGreaterThan(0);
  });

  it.each(
    (['front', 'side', 'top', 'rearquarter'] as const).flatMap((preset) =>
      [0.5, 1, 2].map((aspect) => ({ preset, aspect })),
    ),
  )(
    'centers the target and frames the domain from $preset at aspect $aspect',
    ({ preset, aspect }) => {
      const target: Point3 = [4, -2, 7];
      const camera = new OrbitCamera(preset, target, Math.sqrt(3));
      const [x, y, z] = project(camera, target, aspect);
      expect(x).toBeCloseTo(0, 5);
      expect(y).toBeCloseTo(0, 5);
      expect(z).toBeGreaterThan(0);
      expect(z).toBeLessThan(1);
      for (const index of Array.from({ length: 8 }, (_, i) => i)) {
        const dx = index & 1 ? 1 : -1;
        const dy = index & 2 ? 1 : -1;
        const dz = index & 4 ? 1 : -1;
        const [cx, cy, cz] = project(
          camera,
          [target[0] + dx, target[1] + dy, target[2] + dz],
          aspect,
        );
        expect(Math.abs(cx)).toBeLessThan(1);
        expect(Math.abs(cy)).toBeLessThan(1);
        expect(cz).toBeGreaterThan(0);
        expect(cz).toBeLessThan(1);
      }
    },
  );

  it('preserves orbit radius and target while wrapping yaw and clamping pitch', () => {
    const camera = new OrbitCamera('front', [3, 4, 5], 2);
    camera.orbit(1000 * Math.PI, 1000);
    expect(camera.yawRad).toBeGreaterThanOrEqual(0);
    expect(camera.yawRad).toBeLessThan(2 * Math.PI);
    expect(camera.pitchRad).toBeLessThan(Math.PI / 2);
    expect(
      Math.hypot(...camera.eye.map((value, axis) => value - (camera.target[axis] ?? 0))),
    ).toBeCloseTo(camera.distance);
    expect([...camera.viewProjection(1)].every(Number.isFinite)).toBe(true);
    camera.orbit(-1000 * Math.PI, -2000);
    expect(camera.pitchRad).toBeGreaterThan(-Math.PI / 2);
    expect([...camera.viewProjection(1)].every(Number.isFinite)).toBe(true);
    expect(camera.target).toEqual([3, 4, 5]);
  });

  it('zooms proportionally, clamps extremes and resets to the selected preset', () => {
    const camera = new OrbitCamera('side', [1, 2, 3], 2);
    const initial = { yaw: camera.yawRad, pitch: camera.pitchRad, distance: camera.distance };
    camera.zoom(100);
    expect(camera.distance).toBeGreaterThan(initial.distance);
    camera.zoom(-100);
    expect(camera.distance).toBeCloseTo(initial.distance);
    camera.zoom(-1e6);
    expect(camera.distance).toBeCloseTo(2.1);
    camera.zoom(1e6);
    expect(camera.distance).toBe(40);
    camera.orbit(1, 1);
    camera.reset();
    expect(camera.yawRad).toBe(initial.yaw);
    expect(camera.pitchRad).toBe(initial.pitch);
    expect(camera.distance).toBe(initial.distance);
    expect(camera.target).toEqual([1, 2, 3]);
  });

  it('maps the near and far planes to WebGPU depth zero and one', () => {
    const camera = new OrbitCamera('side');
    const nearPoint: Point3 = [0, -camera.distance + camera.radius / 100, 0];
    const farPoint: Point3 = [0, -camera.distance + camera.radius * 100, 0];
    expect(project(camera, nearPoint)[2]).toBeCloseTo(0, 4);
    expect(project(camera, farPoint)[2]).toBeCloseTo(1, 5);
  });

  it.each([0, -1, NaN, Infinity])('rejects invalid radius and aspect %s', (value) => {
    expect(() => new OrbitCamera('front', [0, 0, 0], value)).toThrow('radius');
    expect(() => new OrbitCamera().viewProjection(value)).toThrow('aspect');
  });

  it('rejects a nonfinite target', () => {
    expect(() => new OrbitCamera('front', [NaN, 0, 0])).toThrow('target');
  });
});

it('describes the empty domain honestly and exposes controls without claiming a flow result', () => {
  expect(describeScene(false)).toBe(
    'Wind tunnel domain outline, no body or flow loaded, view ready.',
  );
  expect(describeScene(true)).toBe(
    'Wind tunnel domain outline, no body or flow loaded, view paused.',
  );
  for (const instruction of ['Drag', 'Scroll', 'Arrow keys', 'R resets', 'Space']) {
    expect(CAMERA_INSTRUCTIONS).toContain(instruction);
  }
});
