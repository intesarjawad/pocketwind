struct SliceParams {
  // nx, ny, nz and the y index of the plane.
  size: vec4u,
  // 0 is speed, 1 is Cp.
  field: u32,
  u_lu: f32,
  low: f32,
  high: f32,
  stops: array<vec4f, 9>,
}
@group(0) @binding(1) var<uniform> slice: SliceParams;
@group(0) @binding(2) var values: texture_2d<f32>;
@group(0) @binding(3) var<storage, read> macros: array<vec4f>;
@group(0) @binding(4) var output: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn evaluate(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= slice.size.x || id.y >= slice.size.z) { return; }
  let m = macros[id.x + slice.size.x * (slice.size.w + slice.size.y * id.y)];
  var value: f32;
  if (slice.field == 0u) {
    value = length(m.yzw) / slice.u_lu;
  } else {
    value = (m.x - 1.0) / 3.0 / (0.5 * slice.u_lu * slice.u_lu);
  }
  textureStore(output, vec2i(id.xy), vec4f(value, 0.0, 0.0, 1.0));
}

struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Varyings {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let uv = corners[index];
  let extent = vec2f(f32(slice.size.x - 1u), f32(slice.size.z - 1u));
  let world = vec3f(uv.x * extent.x, f32(slice.size.w), uv.y * extent.y);
  return Varyings(frame.view_projection * vec4f(world, 1.0), uv);
}
@fragment fn fragment(in: Varyings) -> @location(0) vec4f {
  let extent = vec2f(f32(slice.size.x - 1u), f32(slice.size.z - 1u));
  let value = textureLoad(values, vec2i(round(in.uv * extent)), 0).r;
  let t = clamp((value - slice.low) / (slice.high - slice.low), 0.0, 1.0) * 8.0;
  let index = min(u32(floor(t)), 7u);
  return mix(slice.stops[index], slice.stops[index + 1u], t - f32(index));
}
