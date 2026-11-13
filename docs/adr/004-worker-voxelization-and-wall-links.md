# 004: Worker voxelization and wall links

Status: accepted for mesh import and voxelization.

## Context

Mesh parsing and wall-link construction must leave the main thread available for interaction.

## Decision

Parse STL, 3MF and OBJ through the geometry worker. Build voxel flags, wall masks, q links, boundaryCells, frontal area and blockage there. Use triangle bins for wall-link intersection queries.

Read 3MF's ZIP central index and expand only referenced parts with `DecompressionStream('deflate-raw')`. Parsing is asynchronous because decompression uses streams. Merge every build item, following component transforms and production-extension paths, into millimeter coordinates. Preserve the source unit and build item count in the parse result. OBJ has no declared unit and is interpreted as millimeters.

Use a small XML tag scanner for model geometry and package relationships. The [DOMParser interface](https://html.spec.whatwg.org/multipage/dynamic-markup-insertion.html#domparser) is exposed only to Window. [DecompressionStream](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream/DecompressionStream) is available in web workers. These API constraints were checked on 2026-11-05.

## Consequences

A typed worker protocol transfers geometry results to the app. Parsing and voxelization remain independently testable without DOM or GPU access. ZIP64, encryption and compression methods other than store and deflate return explicit errors. Expanded archive size and merged triangle count are bounded before allocating output storage.

Synthetic fixtures cover stored and deflated meshes, build items, component transforms, external model parts, declared units and unsupported archives. A closed, deflated ellipsoid contains 327680 triangles with a 3:1:1 axis ratio.

## Slicer interoperability

PrusaSlicer and Bambu Studio compatibility remains unverified. Synthetic fixtures do not establish compatibility with either application's actual output. Independent 300 mm cube fixtures, with recorded application versions, twelve triangles and 300 mm bounds, remain necessary before public release.
