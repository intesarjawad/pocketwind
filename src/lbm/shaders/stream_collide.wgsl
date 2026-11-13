// Werner and Wengle's wall law, u+ = 8.3 y+^(1/7), joined to u+ = y+ where both give 11.81.
const WALL_A: f32 = 8.3;
const WALL_B: f32 = 1.0 / 7.0;
const WALL_SUBLAYER: f32 = 11.81;
// Halfway bounce-back puts the first fluid node half a cell from the wall.
const WALL_DISTANCE: f32 = 0.5;

fn friction_velocity(speed: f32) -> f32 {
  let viscous = sqrt(p.nu * speed / WALL_DISTANCE);
  if (WALL_DISTANCE * viscous / p.nu <= WALL_SUBLAYER) { return viscous; }
  return pow(speed * pow(p.nu / WALL_DISTANCE, WALL_B) / WALL_A, 1.0 / (1.0 + WALL_B));
}

// A wall takes sum_j 2 c_j (g*_j + w_j) over the links pointing into it. With an unresolved
// boundary layer that sum is set by lattice artefacts rather than by viscosity, so the cell's
// post-collision stress is replaced by the smallest one whose flux along the slip direction is
// the wall-law shear. Only that one flux is prescribed, so the wall stays impermeable.
fn collide_wall(
  g: array<f32, 19>,
  equilibrium: array<f32, 19>,
  rho: f32,
  velocity: vec3f,
  flag: u32,
) -> array<f32, 19> {
  var normal = vec3f(0.0);
  var exposed = 0.0;
  for (var i = 1u; i < 19u; i++) {
    if (has_wall(flag, i)) {
      normal += W[i] * vec3f(C[i]);
      exposed += W[i];
    }
  }
  var slip = velocity;
  let normal_length = length(normal);
  if (normal_length > 1e-3) {
    let n = normal / normal_length;
    slip -= dot(velocity, n) * n;
  }
  let speed = length(slip);
  if (speed < 1e-7) { return collide(g, equilibrium, rho); }
  let t = slip / speed;
  let u_tau = friction_velocity(speed);
  // One flat face has link weights summing to 1/6.
  let shear = 6.0 * exposed * rho * u_tau * u_tau;
  var flux = 0.0;
  var b = Stress(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  for (var i = 1u; i < 19u; i++) {
    if (!has_wall(flag, i)) { continue; }
    let j = opp(i);
    let c = vec3f(C[j]);
    let along = dot(c, t);
    flux += 2.0 * along * (equilibrium[j] + W[j]);
    let s = 9.0 * W[j] * along;
    b.xx += s * (c.x * c.x - 1.0 / 3.0);
    b.yy += s * (c.y * c.y - 1.0 / 3.0);
    b.zz += s * (c.z * c.z - 1.0 / 3.0);
    b.xy += s * c.x * c.y;
    b.xz += s * c.x * c.z;
    b.yz += s * c.y * c.z;
  }
  let norm = b.xx * b.xx + b.yy * b.yy + b.zz * b.zz +
    2.0 * (b.xy * b.xy + b.xz * b.xz + b.yz * b.yz);
  // A flat face gives 0.5; links that carry a tenth of that along the slip would need an
  // outsized stress to set the wall shear, so the cell keeps the plain collision.
  if (norm < 0.05) { return collide(g, equilibrium, rho); }
  // The post-collision stress is set directly, so the relaxation rate drops out.
  let scale = 4.5 * (shear - flux) / norm;
  let trace = b.xx + b.yy + b.zz;
  var post: array<f32, 19>;
  for (var i = 0u; i < 19u; i++) {
    let c = vec3f(C[i]);
    let projected =
      c.x * c.x * b.xx + c.y * c.y * b.yy + c.z * c.z * b.zz +
      2.0 * (c.x * c.y * b.xy + c.x * c.z * b.xz + c.y * c.z * b.yz) - trace / 3.0;
    post[i] = equilibrium[i] + scale * W[i] * projected;
    // Pores can demand an inadmissible stress; shifted g must still give physical f = g + w >= 0.
    if (post[i] + W[i] < 0.0) { return collide(g, equilibrium, rho); }
  }
  return post;
}

// Mass leaves at the reference density with the velocity arriving from upstream.
fn outlet_velocity(position: vec3u) -> vec3f {
  let upstream = idx(position.x - 1u, position.y, position.z);
  var mass = 1.0;
  var momentum = vec3f(0.0);
  for (var i = 0u; i < 19u; i++) {
    let value = load_in(i, upstream);
    mass += value;
    momentum += vec3f(C[i]) * value;
  }
  return momentum / mass;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= p.nx || gid.y >= p.ny || gid.z >= p.nz) { return; }
  let n = idx(gid.x, gid.y, gid.z);
  let flag = geometry[n];
  let kind = flag & CELL_TYPE_MASK;
  if (is_wall(kind)) { return; }
  if (kind == EQ) {
    var inflow = vec3f(p.u_in, 0.0, 0.0);
    if (gid.x == p.nx - 1u && gid.x > 0u) { inflow = outlet_velocity(gid); }
    store_equilibrium(n, 0.0, inflow);
    return;
  }
  var g: array<f32, 19>;
  g[0] = load_in(0u, n);
  for (var i = 1u; i < 19u; i++) {
    if (has_wall(flag, i)) { g[i] = wall_value(i, n, gid, flag); }
    else { g[i] = load_in(i, idx_wrapped(gid, -C[i])); }
  }
  // Keep the density deviation below unit-scale f32 rounding through equilibrium.
  var rho_delta = 0.0;
  var momentum = vec3f(0.0);
  for (var i = 0u; i < 19u; i++) {
    rho_delta += g[i];
    momentum += vec3f(C[i]) * g[i];
  }
  let rho = 1.0 + rho_delta;
  let velocity = momentum / rho;
  var equilibrium: array<f32, 19>;
  for (var i = 0u; i < 19u; i++) {
    equilibrium[i] = geq(i, rho_delta, velocity);
  }
  var post: array<f32, 19>;
  // Bits above the cell type mark wall links; the wall law is part of the sub-grid model.
  if (p.les != 0u && (flag >> 3u) != 0u) {
    post = collide_wall(g, equilibrium, rho, velocity, flag);
  } else {
    post = collide(g, equilibrium, rho);
  }
  for (var i = 0u; i < 19u; i++) { store_out(i, n, post[i]); }
  if (p.write_macro == 1u) { macros[n] = vec4f(rho, velocity); }
}
