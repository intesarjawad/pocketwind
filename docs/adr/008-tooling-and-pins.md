# 008: Tooling and pins

Status: accepted dependency and environment constraints.

## Context

Strict TypeScript and separate browser, geometry-thread, script and test environments keep incompatible globals out of each compilation context.

## Decision

Use the versions pinned in package.json and the lockfile with Node 26, Vite, TypeScript, Biome, Vitest and Playwright. Use TypeScript DOM WebGPU declarations without @webgpu/types. Retain portable hook configuration without changing externally managed core.hooksPath.

## Consequences

package.json pins Vite 8.3.6. Biome enables nursery/noFloatingPromises to reject unhandled promises. No Node fallback or shader-validation backend exception is established here.
