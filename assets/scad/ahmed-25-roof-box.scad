// The 25 degree Ahmed body carrying a 600 x 300 x 150 mm roof box with 20 mm
// rounded vertical and top edges, centred on the body length and the symmetry
// plane. The box starts 1 mm inside the roof so the union has no coplanar faces.
use <ahmed-25.scad>

module roof_box(roof_z, x_centre) {
    length = 600;
    width = 300;
    height = 150;
    radius = 20;
    embed = 1;

    translate([x_centre, 0, roof_z - embed])
        intersection() {
            // Plan view: round the vertical edges.
            linear_extrude(height = height + embed)
                hull()
                    for (sx = [-1, 1], sy = [-1, 1])
                        translate([sx * (length / 2 - radius), sy * (width / 2 - radius)])
                            circle(r = radius);
            // End view: round the top edges along the length.
            rotate([90, 0, 90])
                linear_extrude(height = length, center = true)
                    hull() {
                        for (side = [-1, 1])
                            translate([side * (width / 2 - radius), height + embed - radius])
                                circle(r = radius);
                        translate([-width / 2, 0])
                            square([width, height + embed - radius]);
                    }
            // Side view: round the top edges across the width.
            rotate([90, 0, 0])
                linear_extrude(height = width, center = true)
                    hull() {
                        for (side = [-1, 1])
                            translate([side * (length / 2 - radius), height + embed - radius])
                                circle(r = radius);
                        translate([-length / 2, 0])
                            square([length, height + embed - radius]);
                    }
        }
}

union() {
    ahmed_body(25, 50);
    roof_box(50 + 288, 522);
}
