// Ahmed et al. (1984) body in millimetres. x runs from the nose to the tail,
// y is centred on the symmetry plane and the underside sits `lift` above z = 0,
// the floor the stilts stand on. The rear slant length is measured along the slant.
// Resolution comes from the command line: openscad -D '$fn=96'.

module ahmed_body(slant_deg = 25, lift = 50) {
    length = 1044;
    width = 389;
    height = 288;
    slant_length = 222;
    front_radius = 100;
    slant_dx = slant_length * cos(slant_deg);
    slant_dz = slant_length * sin(slant_deg);

    translate([0, 0, lift])
        intersection() {
            // Side view: round the top and bottom front edges and cut the rear slant.
            rotate([90, 0, 0])
                linear_extrude(height = width, center = true)
                    hull() {
                        for (z = [front_radius, height - front_radius])
                            translate([front_radius, z])
                                circle(r = front_radius);
                        polygon([
                            [front_radius, 0],
                            [length, 0],
                            [length, height - slant_dz],
                            [length - slant_dx, height],
                            [front_radius, height - front_radius]
                        ]);
                    }
            // Plan view: round the two vertical front edges.
            linear_extrude(height = height)
                hull() {
                    for (side = [-1, 1])
                        translate([front_radius, side * (width / 2 - front_radius)])
                            circle(r = front_radius);
                    translate([front_radius, -width / 2])
                        square([length - front_radius, width]);
                }
        }
}

ahmed_body();
