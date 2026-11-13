# 007: Rendering without three.js

Status: accepted design; validation evidence remains pending.

## Context

Compute and visualization need access to the same device and macroscopic fields without a second rendering abstraction.

## Decision

Use WebGPU directly for mesh, particles, lines and slice rendering. Share one GPUDevice with the solver. Use vanilla TypeScript and DOM controls without a UI framework or state library; use wgpu-matrix for camera mathematics.

## Consequences

The project owns rendering pipelines and camera behavior. Only app modules access the DOM; GPU and render modules receive their resources explicitly. Visual design and rendered behavior remain unverified here.
