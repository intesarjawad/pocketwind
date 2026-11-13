@vertex fn vertex(@location(0) position: vec3f) -> @builtin(position) vec4f {
  return frame.view_projection * vec4f(position, 1.0);
}
@fragment fn fragment() -> @location(0) vec4f {
  return frame.line;
}
