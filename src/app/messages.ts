export type MessageId =
  | 'webgpu-missing'
  | 'adapter-unavailable'
  | 'device-unavailable'
  | 'firefox-linux'
  | 'chromium-linux'
  | 'firefox-android'
  | 'apple-browser'
  | 'android-browser'
  | 'desktop-browser'
  | 'tier-s-only'
  | 'tier-xl-unavailable'
  | 'storage-f16-unavailable'
  | 'allocation-step-down'
  | 'allocation-failed'
  | 'run-unstable'
  | 'run-not-finite'
  | 'run-file-too-large'
  | 'run-file-invalid'
  | 'run-file-version'
  | 'run-file-missing-field'
  | 'compare-grid-mismatch'
  | 'compare-setting-mismatch'
  | 'compare-version-mismatch'
  | 'model-too-large'
  | 'model-unsupported-cad'
  | 'model-unsupported-format'
  | 'model-truncated'
  | 'model-not-stl'
  | 'model-too-many-triangles'
  | 'model-empty'
  | 'model-non-finite'
  | 'model-zip-unsupported'
  | 'model-no-model-part'
  | 'model-bad-xml'
  | 'model-operation-failed'
  | 'model-no-solid-cells'
  | 'model-read-failed';

export const NEXT_VERBS = [
  'Open',
  'Drop',
  'Export',
  'Reload',
  'Lower',
  'Raise',
  'Drag',
  'Choose',
  'Run',
  'Use',
  'Wait',
  'Repair',
  'Decimate',
  'Install',
  'Close',
  'Try',
] as const;

export const MESSAGES = {
  'allocation-step-down': {
    what: 'The GPU ran out of memory. Running tier {tier} instead.',
    next: 'Close other GPU-heavy tabs, or choose a lower tier under Advanced.',
  },
  'allocation-failed': {
    what: 'The GPU ran out of memory at tier {tier}. No run was started.',
    next: 'Close other GPU-heavy tabs, or choose a lower tier under Advanced.',
  },
  'run-unstable': {
    what: 'The run went unstable at step N and was reset',
    next: 'Lower the speed, or choose a higher tier under Advanced',
  },
  'run-not-finite': {
    what: 'The run stopped being finite at step N.',
    next: 'Choose the other operator, or lower the speed',
  },
  'run-file-too-large': {
    what: 'The run file is larger than 5 MB.',
    next: 'Choose a run file exported by this app.',
  },
  'run-file-invalid': {
    what: 'The run file is not valid JSON.',
    next: 'Choose a run file exported by this app.',
  },
  'run-file-version': {
    what: 'The run file uses an unknown schema version.',
    next: 'Export the run again from this app.',
  },
  'run-file-missing-field': {
    what: 'The run file is missing a required field.',
    next: 'Export the run again from this app.',
  },
  'compare-grid-mismatch': {
    what: 'The saved run used grid {saved}; this run allocated {current}.',
    next: 'Run both models on the same grid before comparing.',
  },
  'compare-setting-mismatch': {
    what: 'The saved run used tier {tier}, {speed} m/s and the {rule} reference area.',
    next: 'Choose tier {tier} and {speed} m/s, then compare again.',
  },
  'compare-version-mismatch': {
    what: 'The saved run was made with different solver numerics, so its drag cannot be compared with this version.',
    next: 'Run both models again on this version.',
  },
  'model-too-large': {
    what: 'The model file is larger than 200 MB.',
    next: 'Decimate the model in your CAD tool, then drop it again.',
  },
  'model-unsupported-cad': {
    what: 'This file is a CAD document, not a mesh.',
    next: 'Export STL or 3MF from your CAD tool, then drop the exported file.',
  },
  'model-unsupported-format': {
    what: 'The file type is not supported.',
    next: 'Choose an STL, 3MF or OBJ file.',
  },
  'model-truncated': {
    what: 'The model ends before the mesh is complete.',
    next: 'Export the model again, then drop it.',
  },
  'model-not-stl': {
    what: 'The file does not contain a valid mesh.',
    next: 'Export STL or 3MF from your CAD tool, then drop the exported file.',
  },
  'model-too-many-triangles': {
    what: 'The model has more than 2,000,000 triangles.',
    next: 'Decimate the model, then drop it again.',
  },
  'model-empty': {
    what: 'The model contains no triangles.',
    next: 'Choose a model with a surface mesh.',
  },
  'model-non-finite': {
    what: 'A vertex is outside the finite coordinate range.',
    next: 'Repair the model in your CAD tool, then export it again.',
  },
  'model-zip-unsupported': {
    what: 'The 3MF archive uses an unsupported compression or encryption feature.',
    next: 'Export the model as STL, then drop it.',
  },
  'model-no-model-part': {
    what: 'The 3MF archive has no model part.',
    next: 'Export the model as STL, then drop it.',
  },
  'model-bad-xml': {
    what: 'The 3MF model XML could not be read.',
    next: 'Export the model as STL, then drop it.',
  },
  'model-operation-failed': {
    what: 'The model could not be processed.',
    next: 'Try dropping it again, or export the model as STL.',
  },
  'model-no-solid-cells': {
    what: 'The model has no solid cells at this size.',
    next: 'Raise the size, or choose a larger tier under Advanced.',
  },
  'model-read-failed': {
    what: 'The file could not be read.',
    next: 'Try dropping it again.',
  },
  'webgpu-missing': {
    what: 'This browser does not expose WebGPU.',
    next: 'Open this page in an up-to-date Chrome, Edge or Safari browser.',
  },
  'adapter-unavailable': {
    what: 'WebGPU could not find an available GPU adapter.',
    next: 'Open the browser GPU diagnostics and check whether WebGPU is available.',
  },
  'device-unavailable': {
    what: 'WebGPU could not create a device on this GPU.',
    next: 'Close other GPU-heavy tabs, reload this page, then check the browser GPU diagnostics.',
  },
  'firefox-linux': {
    what: 'Firefox on Linux does not enable WebGPU by default.',
    next: 'Open this page in current Chrome or Edge on Intel Gen12+, or NVIDIA with driver 535.183.01+ under Wayland.',
  },
  'chromium-linux': {
    what: 'This Chromium browser on Linux could not start WebGPU.',
    next: 'Open chrome://gpu (Edge: edge://gpu) and check the WebGPU line; update Chrome to 144+ on Intel Gen12+, or 147+ on NVIDIA with driver 535.183.01+ under Wayland.',
  },
  'firefox-android': {
    what: 'Firefox on Android does not enable WebGPU by default.',
    next: 'Open this page in current Chrome on Android with a supported GPU.',
  },
  'apple-browser': {
    what: 'This browser on an Apple device could not start WebGPU.',
    next: 'Open this page in Safari 26 or later after updating the operating system.',
  },
  'android-browser': {
    what: 'This Android browser could not start WebGPU.',
    next: 'Open this page in Chrome 121 or later on Android 12 or later with an ARM, Qualcomm or Intel GPU.',
  },
  'desktop-browser': {
    what: 'This browser could not start WebGPU.',
    next: 'Open this page in current Chrome or Edge with hardware acceleration enabled, then check chrome://gpu or edge://gpu.',
  },
  'tier-s-only': {
    what: 'This GPU reports limits below the larger-grid requirements. The tunnel is limited to tier S.',
    next: 'Use tier S on this GPU, or open this page on a GPU with higher limits.',
  },
  'tier-xl-unavailable': {
    what: 'Tier XL is unavailable: this GPU reports {limit} below the {required} bytes it needs. A smaller tier runs instead.',
    next: 'Choose a smaller tier under Advanced, or open this page on a GPU with higher limits.',
  },
  'storage-f16-unavailable': {
    what: 'This GPU does not offer float16 storage. The run uses float32 instead.',
    next: 'Choose float32 under Advanced, or open this page on a GPU that offers shader-f16.',
  },
} satisfies Record<MessageId, { what: string; next: string }>;
