struct Surface {
  @builtin(position) clip: vec4f,
  @location(0) position: vec3f,
  @location(1) @interpolate(flat) normal: vec3f,
}
@vertex fn vertex(@location(0) position: vec3f, @location(1) normal: vec3f) -> Surface {
  return Surface(frame.view_projection * vec4f(position, 1.0), position, normal);
}
@fragment fn fragment(surface: Surface, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let n = select(-surface.normal, surface.normal, front);
  let v = normalize(frame.eye.xyz - surface.position);
  let key = max(0.0, dot(n, normalize(vec3f(-1.0, -1.0, 2.0))));
  let fill = max(0.0, dot(n, normalize(vec3f(1.0, 1.0, 1.0))));
  let rim = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 3.0) * 0.35;
  let light = vec3f(0.15) + key * vec3f(1.0, 0.95, 0.9) + fill * vec3f(0.2, 0.25, 0.3);
  return vec4f(frame.body.rgb * light + vec3f(rim), frame.body.a);
}
