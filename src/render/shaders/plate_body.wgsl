// The body's side silhouette in red and its stilts in green. The stilts stand off the
// centre plane, so the smoke on the plane passes in front of them.
struct Map { map: vec4f, size: vec4f }
@group(0) @binding(0) var<uniform> m: Map;

struct Out { @builtin(position) position: vec4f, @location(0) @interpolate(flat) part: u32 }

@vertex fn vertex(@location(0) position: vec3f, @builtin(instance_index) part: u32) -> Out {
  let pixel = vec2f(m.map.y + position.x * m.map.x, m.map.z - position.z * m.map.x);
  return Out(vec4f(pixel.x / m.size.x * 2.0 - 1.0, 1.0 - pixel.y / m.size.y * 2.0, 0.0, 1.0), part);
}

@fragment fn fragment(in: Out) -> @location(0) vec4f {
  return select(vec4f(1.0, 0.0, 0.0, 1.0), vec4f(0.0, 1.0, 0.0, 1.0), in.part == 1u);
}
