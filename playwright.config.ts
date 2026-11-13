import { defineConfig, type Project } from '@playwright/test';

const projects: Project[] = [
  {
    name: 'chromium-cpu',
    testIgnore:
      /\/(shaders|gpu-vs-cpu|force|particles|render|nan-guard|scene|perf|compare|result-card|launch-views)\.spec\.ts$/,
    grepInvert: /@gpu/,
    use: { browserName: 'chromium' },
  },
];

if (process.platform === 'darwin') {
  projects.push(
    { name: 'mac-gpu', use: { browserName: 'chromium', headless: false } },
    { name: 'webkit-gpu', use: { browserName: 'webkit' } },
  );
}

if (process.env.CI) {
  projects.push({
    name: 'chromium-gpu-swiftshader',
    use: {
      browserName: 'chromium',
      launchOptions: {
        args: [
          '--enable-unsafe-webgpu',
          '--enable-features=Vulkan',
          '--use-angle=vulkan',
          '--use-vulkan=swiftshader',
          '--use-webgpu-adapter=swiftshader',
        ],
      },
    },
  });
}

export default defineConfig({
  testDir: 'tests/browser',
  webServer: {
    command: 'npm run build && npm run preview -- --port 49327 --strictPort',
    url: 'http://localhost:49327/pocketwind/',
    reuseExistingServer: false,
  },
  use: { baseURL: 'http://localhost:49327/pocketwind/' },
  projects,
});
