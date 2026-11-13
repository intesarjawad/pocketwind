@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= p.nx || gid.y >= p.ny || gid.z >= p.nz) { return; }
  let n = idx(gid.x, gid.y, gid.z);
  let kind = geometry[n] & CELL_TYPE_MASK;
  let velocity = select(vec3f(p.u_in, 0.0, 0.0), vec3f(0.0), is_wall(kind));
  store_equilibrium(n, 0.0, velocity);
}
