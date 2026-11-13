@group(0) @binding(0) var<storage, read> macros: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> unstable: atomic<u32>;

@compute @workgroup_size(64)
fn main(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(num_workgroups) workgroups: vec3u,
) {
  let cell = gid.x + gid.y * workgroups.x * 64u;
  if (cell >= arrayLength(&macros)) { return; }
  // Populations are shifted; macro.x stores the physical density, 1 + sum(g).
  let rho = macros[cell].x;
  let non_finite = (bitcast<u32>(rho) & 0x7fffffffu) >= 0x7f800000u;
  if (non_finite || rho < 0.5 || rho > 1.5) {
    atomicOr(&unstable, 1u);
  }
}
