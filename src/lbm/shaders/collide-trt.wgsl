fn collide(g: array<f32, 19>, equilibrium: array<f32, 19>, rho: f32) -> array<f32, 19> {
  let tau = relaxation_time(g, equilibrium, rho);
  let omega_plus = 1.0 / tau;
  let omega_minus = 1.0 / (p.lambda / (tau - 0.5) + 0.5);
  var post: array<f32, 19>;
  post[0] = g[0] - omega_plus * (g[0] - equilibrium[0]);
  for (var i = 1u; i < 19u; i += 2u) {
    let j = opp(i);
    let even = 0.5 * omega_plus * (g[i] + g[j] - equilibrium[i] - equilibrium[j]);
    let odd = 0.5 * omega_minus * (g[i] - g[j] - equilibrium[i] + equilibrium[j]);
    post[i] = g[i] - even - odd;
    post[j] = g[j] - even + odd;
  }
  return post;
}
