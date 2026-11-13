/** Describe only content currently drawn, without implying a computed flow. */
export function describeScene(paused: boolean): string {
  return `Wind tunnel domain outline, no body or flow loaded, view ${paused ? 'paused' : 'ready'}.`;
}

export const CAMERA_INSTRUCTIONS =
  'Drag to orbit. Scroll to zoom. Arrow keys orbit. R resets the camera. Space pauses or resumes.';
