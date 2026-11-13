@group(0) @binding(9) var<storage, read> boundary_cells: array<u32>;
@group(0) @binding(10) var<storage, read_write> partials: array<vec4f>;
@group(0) @binding(11) var<uniform> boundary_count: vec4u;

var<workgroup> force_sum: array<vec4f, 64>;

@compute @workgroup_size(64)
fn main(
  @builtin(workgroup_id) group: vec3u,
  @builtin(num_workgroups) groups: vec3u,
  @builtin(local_invocation_index) lane: u32,
) {
  let partial = group.x + groups.x * group.y;
  let item = 64u * partial + lane;
  var force = vec3f(0.0);
  if (item < boundary_count.x) {
    let n = boundary_cells[item];
    let flag = geometry[n];
    let position = vec3u(n % p.nx, (n / p.nx) % p.ny, n / (p.nx * p.ny));
    for (var i = 1u; i < 19u; i++) {
      if (!has_wall(flag, i)) { continue; }
      let neighbor = idx_wrapped(position, -C[i]);
      if ((geometry[neighbor] & CELL_TYPE_MASK) != SOLID) { continue; }
      let j = opp(i);
      // c_j (f*_j + f_i) with f_i as the next step reconstructs it. The rest weights carry
      // the reference pressure, which a closed surface cancels and a body cut by its
      // supports must not feel, so the deviations alone give the force.
      force += vec3f(C[j]) * (load_in(j, n) + wall_value(i, n, position, flag));
    }
  }
  // Each sample sums the two latest states; halving averages out the period-two oscillation.
  force_sum[lane] = vec4f(0.5 * force, 0.0);
  workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride /= 2u) {
    if (lane < stride) { force_sum[lane] += force_sum[lane + stride]; }
    workgroupBarrier();
  }
  // Padded groups must overwrite their partial with zero before the final reduction.
  if (lane == 0u) { partials[partial] = force_sum[0]; }
}
