@group(0) @binding(0) var<storage, read> partials: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> result: array<vec4f>;

var<workgroup> force_sum: array<vec4f, 256>;

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) lane: u32) {
  var sum = vec4f(0.0);
  // Striding also handles more than 256 partials without another allocation or pass.
  for (var i = lane; i < arrayLength(&partials); i += 256u) { sum += partials[i]; }
  force_sum[lane] = sum;
  workgroupBarrier();
  for (var stride = 128u; stride > 0u; stride /= 2u) {
    if (lane < stride) { force_sum[lane] += force_sum[lane + stride]; }
    workgroupBarrier();
  }
  if (lane == 0u) { result[0] = force_sum[0]; }
}
