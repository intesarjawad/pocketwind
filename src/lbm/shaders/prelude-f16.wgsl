enable f16;

alias pop = f16;

const POP_SCALE: f32 = 32768.0;

fn encode_population(value: f32, i: u32, n: u32) -> pop {
  let bits = bitcast<u32>(value);
  // lowbias32 (hash-prospector) decorrelates cells, directions and changing values.
  var random = bits ^ (n * 0x9e3779b9u) ^ (i * 0x85ebca6bu);
  random = (random ^ (random >> 16u)) * 0x7feb352du;
  random = (random ^ (random >> 15u)) * 0x846ca68bu;
  random ^= random >> 16u;
  let magnitude = bits & 0x7fffffffu;
  // 0x38800000 is 2^-14, the smallest normal half; retain the subnormal path.
  if (magnitude < 0x38800000u) { return pop(value); }
  // A half has 13 fewer significand bits. Choose either neighbour in proportion
  // to the discarded fraction, instead of repeating the same mass error at every cell.
  let increment = select(0u, 0x2000u, (random & 0x1fffu) < (magnitude & 0x1fffu));
  let rounded = (magnitude & 0xffffe000u) + increment;
  return pop(bitcast<f32>((bits & 0x80000000u) | rounded));
}
