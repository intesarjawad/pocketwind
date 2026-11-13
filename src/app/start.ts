import type { GpuSupport } from '../gpu/device';
import { detectGpu, XL_LIMITS } from '../gpu/device';
import { BUILD_COMMIT, BUILD_NUMERICS_HASH } from '../io/build-info';
import { buildRunFile } from '../io/run-export';
import type { ForceHistoryPoint, RunFile } from '../io/run-file';
import { isRunFileRefusal, parseRunFile } from '../io/run-file';
import { TIERS } from '../lbm/layout';
import { renderBenchRoute } from './bench-page';
import { isUnattended, runBodyGridCheck, runUnattended } from './case-run';
import {
  type CompareBuild,
  type CompareRow,
  compareOutcome,
  compareRefusal,
  prepareComparison,
  rowOfRun,
  run2LimitSteps,
} from './compare';
import { createComparePanel } from './compare-panel';
import { createDropzone, type LoadedModel } from './dropzone';
import { createEmbedControl, createEmbedView, renderEmbedUnsupported } from './embed';
import { createForceReport, type ForceReportUpdate } from './force-plot';
import { gridBandText } from './grid-check';
import { MESSAGES } from './messages';
import { createPanel } from './panel';
import { DEFAULT_SETTINGS, presetById } from './params';
import { createPlateCaption } from './plate-caption';
import { currentRoute, isEmbedRoute, watchRoute } from './routes';
import { type RunHandle, startRun } from './run';
import {
  type Body,
  bodyFor,
  laminarPlate,
  runFileReport,
  runLengthCells,
  settingsFromHash,
  settingsOfRun,
} from './run-plan';
import type { Settings } from './settings';
import { createShareControls } from './share-controls';
import { createStore, type SettingsStore, type StoreChange } from './store';
import { renderUnsupported } from './unsupported';
import { renderValidateRoute } from './validate-page';

type SupportedGpu = Extract<GpuSupport<GPUDevice>, { status: 'supported' }>;

// A slider drag must not allocate a grid per pixel; only the resting value restarts.
const LIVE_RESTART_DELAY_MS = 250;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createRunFileControl(onLoad: (run: RunFile) => void): HTMLElement {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Run file');
  const label = document.createElement('label');
  label.textContent = 'Open a saved run';
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  label.append(input);
  const status = document.createElement('p');
  status.setAttribute('role', 'alert');
  status.hidden = true;

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (file === undefined) return;
    let result: ReturnType<typeof parseRunFile>;
    try {
      result = parseRunFile(await file.arrayBuffer());
    } catch {
      const message = MESSAGES['run-file-invalid'];
      status.textContent = `${message.what} ${message.next}`;
      status.hidden = false;
      return;
    }
    if (isRunFileRefusal(result)) {
      const message = MESSAGES[result.messageId];
      status.textContent = `${message.what} ${message.next}`;
      status.hidden = false;
      return;
    }
    status.hidden = true;
    onLoad(result);
  });

  section.append(label, status);
  return section;
}

/** A note under the plate: a numbered heading and a line on what it holds, then its controls. */
function chapter(
  id: string,
  title: string,
  note: string | null,
  ...children: HTMLElement[]
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'chapter';
  section.id = id;
  section.setAttribute('aria-labelledby', `${id}-title`);
  const head = document.createElement('header');
  head.className = 'chapter__head';
  const heading = document.createElement('h2');
  heading.id = `${id}-title`;
  heading.textContent = title;
  head.append(heading);
  if (note !== null) {
    const line = document.createElement('p');
    line.textContent = note;
    head.append(line);
  }
  const body = document.createElement('div');
  body.className = 'chapter__body';
  body.append(...children);
  section.append(head, body);
  return section;
}

export function startApp(root: HTMLElement, canvas: HTMLCanvasElement): void {
  let support: Promise<GpuSupport<GPUDevice>> | undefined;
  let gpu: SupportedGpu | undefined;
  let routeVersion = 0;
  let routeAbort: AbortController | undefined;
  let run: RunHandle | undefined;
  let store: SettingsStore | undefined;
  let report: ReturnType<typeof createForceReport> | undefined;
  let embedReadout: ReturnType<typeof createEmbedView>['readout'] | undefined;
  let notice: HTMLElement | undefined;
  let dropped: LoadedModel | undefined;
  let droppedName: string | undefined;
  let comparePanel: ReturnType<typeof createComparePanel> | undefined;
  let caption: ReturnType<typeof createPlateCaption> | undefined;
  let plates = 0;
  const masthead = document.querySelector<HTMLElement>('.masthead');
  const expose = document.querySelector<HTMLButtonElement>('.masthead__expose');
  // Run 1 of a comparison: the previous run, or a saved run file, kept while run 2 measures.
  let frozen: RunFile | undefined;
  let loadedRun: RunFile | undefined;
  let checkingGrid = false;
  let runSettings: Settings | undefined;
  let appMounted = false;
  let restartQueued = false;
  let liveTimer: ReturnType<typeof setTimeout> | undefined;

  function setNotice(message: string, role: 'status' | 'alert' = 'status'): void {
    if (notice === undefined) return;
    notice.setAttribute('role', role);
    notice.textContent = message;
    notice.hidden = false;
  }

  function currentRunFile(settings: Settings): RunFile | null {
    if (loadedRun !== undefined) return loadedRun;
    if (run === undefined) return null;
    const described = runSettings ?? settings;
    return buildRunFile({
      ...run.snapshot(),
      name: described.presetId,
      settings: described,
      commit: BUILD_COMMIT,
      numericsHash: BUILD_NUMERICS_HASH,
    });
  }

  function createShare(current: SettingsStore): HTMLElement {
    return createShareControls({
      settings: () => current.settings,
      unavailable: () =>
        laminarPlate(location.hash, current.settings, TIERS.M.nx)
          ? 'Export is unavailable for the Re 100 validation plate.'
          : null,
      runFile: () => currentRunFile(current.settings),
      resultCard: async () => {
        if (run === undefined) return null;
        const name = (runSettings ?? current.settings).presetId;
        return { name, png: await run.resultCard() };
      },
    });
  }

  function disposeRun(): void {
    routeAbort?.abort();
    routeAbort = undefined;
    if (run === undefined) return;
    if (store?.settings.compare.enabled && run.history.length > 0) {
      frozen = currentRunFile(runSettings ?? store.settings) ?? frozen;
    }
    run.dispose();
    run = undefined;
    runSettings = undefined;
  }

  function compareBuild(): CompareBuild | undefined {
    if (gpu === undefined) return undefined;
    // The device is raised on demand, so an adapter that allows XL already counts as XL-capable.
    const tierPolicy = gpu.tierPolicy === 's-m-l' && gpu.xl.available ? 's-m-l-xl' : gpu.tierPolicy;
    return { numericsHash: BUILD_NUMERICS_HASH, tierPolicy };
  }

  async function compareWithFile(file: File): Promise<void> {
    const build = compareBuild();
    if (store === undefined || build === undefined) return;
    let prepared: ReturnType<typeof prepareComparison>;
    try {
      prepared = prepareComparison(await file.arrayBuffer(), store.settings, build);
    } catch {
      const message = MESSAGES['run-file-invalid'];
      comparePanel?.showRefusal(`${message.what} ${message.next}`);
      return;
    }
    if ('text' in prepared) {
      comparePanel?.showRefusal(prepared.text);
      return;
    }
    disposeRun();
    frozen = prepared.run;
    store.update({ compare: { enabled: true } });
    await restartRun();
  }

  function scheduleRestart(): void {
    if (!appMounted || restartQueued) return;
    restartQueued = true;
    queueMicrotask(() => {
      restartQueued = false;
      void restartRun();
    });
  }

  async function restartRun(): Promise<void> {
    if (!appMounted || currentRoute() !== '' || store === undefined) return;
    const version = routeVersion;
    disposeRun();
    await mountRun(store, version);
  }

  function onStoreChange(change: StoreChange): void {
    if (change.changed.includes('compare') && !change.settings.compare.enabled) {
      frozen = undefined;
      comparePanel?.showRefusal(null);
      comparePanel?.show(null);
    }
    if (!appMounted || change.kind === 'view') return;
    if (change.kind === 'live') {
      if (liveTimer !== undefined) clearTimeout(liveTimer);
      liveTimer = setTimeout(() => {
        liveTimer = undefined;
        scheduleRestart();
      }, LIVE_RESTART_DELAY_MS);
      return;
    }
    scheduleRestart();
  }

  function noteXlUnavailable(tier: Settings['tier'], xl: SupportedGpu['xl']): void {
    if (tier !== 'XL' || xl.available) return;
    const message = MESSAGES['tier-xl-unavailable'];
    const required = String(XL_LIMITS[xl.reason]);
    const what = message.what.replace('{limit}', xl.reason).replace('{required}', required);
    setNotice(`${what} ${message.next}`);
  }

  /**
   * A device cannot gain limits after creation, so choosing XL on an adapter that
   * allows it replaces the default device. No run is live when this is called.
   * Returns false when the raised device could not be created.
   */
  async function raiseLimitsForXl(): Promise<boolean> {
    if (gpu === undefined || !gpu.xl.available || gpu.tierPolicy !== 's-m-l') return true;
    const previous = gpu.device;
    support = detectGpu('gpu' in navigator ? navigator.gpu : undefined, { xl: true });
    const result = await support;
    if (result.status !== 'supported') {
      support = Promise.resolve(gpu);
      return false;
    }
    gpu = result;
    previous.destroy();
    return true;
  }

  async function mountRun(current: SettingsStore, version: number): Promise<void> {
    if (gpu === undefined || (report === undefined && embedReadout === undefined)) return;
    loadedRun = undefined;
    if (notice !== undefined) notice.hidden = true;
    if (current.settings.tier === 'XL') {
      const raised = await raiseLimitsForXl();
      if (version !== routeVersion || gpu === undefined) return;
      if (!raised) {
        const message = MESSAGES['allocation-step-down'];
        setNotice(`${message.what.replace('{tier}', 'L')} ${message.next}`);
      }
    }
    const body = bodyFor(current.settings.presetId, dropped?.mesh, droppedName);
    if (body === null) {
      canvas.hidden = true;
      setNotice(
        'This link names a custom run, but a model file cannot travel in a link. Drop the model again.',
      );
      return;
    }
    const controller = new AbortController();
    routeAbort = controller;
    canvas.hidden = false;
    await launchRun(current, body, controller, version);
  }

  /** Check the frozen run against this run's settings, then follow run 2 against it. */
  function beginComparison(
    settings: Settings,
    body: Body,
    signal: AbortSignal,
  ): { overlay: readonly ForceHistoryPoint[] | undefined; update: (u: ForceReportUpdate) => void } {
    const comparing = settings.compare.enabled ? frozen : undefined;
    const build = compareBuild();
    const refusal =
      comparing === undefined || build === undefined
        ? null
        : compareRefusal(comparing, settings, build);
    comparePanel?.showRefusal(refusal?.text ?? null);
    const overlay = comparing?.forceHistory.length ? comparing.forceHistory : undefined;
    if (comparing === undefined || refusal !== null) {
      return { overlay, update: () => comparePanel?.show(null) };
    }
    const first = rowOfRun(comparing, presetById(comparing.presetId)?.name ?? comparing.name);
    return {
      overlay,
      update(update) {
        if (signal.aborted) return;
        const allocatedRefusal =
          build === undefined
            ? null
            : compareRefusal(comparing, settings, build, update.readout.grid);
        if (allocatedRefusal !== null) {
          comparePanel?.show(null);
          comparePanel?.showRefusal(allocatedRefusal.text);
          return;
        }
        const { summary } = update.readout;
        const second: CompareRow = {
          label: body.label,
          cd: summary.cd,
          cdaM2: update.cdaM2 ?? null,
          status: summary.status,
          semPct: summary.semPct ?? null,
        };
        const lastStep = update.history[update.history.length - 1]?.[0] ?? 0;
        comparePanel?.show({
          first,
          second,
          outcome: compareOutcome(first, second, {
            step: lastStep,
            limitSteps: run2LimitSteps(update.readout.grid.nx),
          }),
        });
      },
    };
  }

  async function launchRun(
    current: SettingsStore,
    body: Body,
    controller: AbortController,
    version: number,
  ): Promise<void> {
    if (gpu === undefined) return;
    noteXlUnavailable(current.settings.tier, gpu.xl);
    const laminar = laminarPlate(location.hash, current.settings, TIERS.M.nx);
    const comparison = beginComparison(
      laminar ? { ...current.settings, compare: { enabled: false } } : current.settings,
      body,
      controller.signal,
    );
    plates += 1;
    const empty = current.settings.presetId === 'none';
    if (caption !== undefined) {
      caption.element.hidden = empty;
      caption.overlay.toggleAttribute('hidden', empty);
    }
    if (empty) setNotice('Empty tunnel: smoke traces the flow; there is no body drag to report.');
    const effectiveSettings = laminar
      ? { ...current.settings, speedMps: laminar.speedMps }
      : current.settings;
    caption?.begin({
      plate: plates,
      presetId: current.settings.presetId,
      label: body.label,
      speedMps: effectiveSettings.speedMps,
      laminar: laminar !== null,
      bodyLengthMm: current.settings.bodyLengthMm,
    });
    try {
      const started = await startRun({
        canvas,
        device: gpu.device,
        settings: effectiveSettings,
        mesh: body.mesh,
        supports: body.supports,
        bodyLabel: body.label,
        tierPolicy: gpu.tierPolicy,
        onUpdate: (update: ForceReportUpdate) => {
          report?.update(update);
          caption?.update(update);
          embedReadout?.update(update.readout);
          comparison.update(update);
        },
        onNotice: (message: string) => setNotice(message),
        onExposure: (exposure) => caption?.expose(exposure),
        ...(comparison.overlay === undefined ? {} : { compare: comparison.overlay }),
        signal: controller.signal,
      });
      if (version !== routeVersion) {
        started?.dispose();
        return;
      }
      run = started ?? undefined;
      if (run !== undefined) runSettings = effectiveSettings;
    } catch (error) {
      if (controller.signal.aborted || version !== routeVersion) return;
      canvas.hidden = true;
      setNotice(`The run could not start. ${errorText(error)}`, 'alert');
    }
  }

  async function checkGrid(): Promise<void> {
    if (checkingGrid || store === undefined || gpu === undefined || run === undefined) return;
    if (gpu.tierPolicy === 's-only') {
      setNotice('Check grid needs tiers M and L; this GPU supports tier S only.');
      return;
    }
    const settings = store.settings;
    const body = bodyFor(settings.presetId, dropped?.mesh, droppedName);
    if (body === null || settings.presetId === 'none') return;
    const grid = run.snapshot().grid;
    const version = routeVersion;
    const current = store;
    const previousFrozen = frozen;
    checkingGrid = true;
    disposeRun();
    const controller = new AbortController();
    routeAbort = controller;
    canvas.hidden = true;
    setNotice(
      'Checking grids S, M and L at one Reynolds number. Changing settings cancels the check.',
    );
    try {
      const result = await runBodyGridCheck(
        gpu.device,
        settings,
        body,
        {
          nx: grid.nx,
          lengthCells: runLengthCells(settings.presetId, body.mesh, grid, settings.floor),
        },
        controller.signal,
        location.hash,
      );
      if (controller.signal.aborted || version !== routeVersion) return;
      frozen = previousFrozen;
      await mountRun(current, version);
      if (version === routeVersion)
        setNotice(
          result.kind === 'done'
            ? `S/M/L check at Re ${result.re.toPrecision(3)}: finest-grid ${gridBandText(result.band)}.`
            : 'Grid check cancelled.',
        );
    } catch (error) {
      if (controller.signal.aborted || version !== routeVersion) return;
      await mountRun(current, version);
      setNotice(`Grid check failed. ${errorText(error)}`, 'alert');
    } finally {
      checkingGrid = false;
    }
  }

  async function mountApp(version: number): Promise<void> {
    appMounted = false;
    const settings = settingsFromHash(location.hash, store?.settings ?? DEFAULT_SETTINGS);
    if (store === undefined) {
      store = createStore(settings);
      store.subscribe(onStoreChange);
    } else {
      store.replace(settings);
    }
    const current = store;

    if (isEmbedRoute()) {
      const view = createEmbedView(location.href);
      embedReadout = view.readout;
      notice = document.createElement('p');
      notice.setAttribute('role', 'status');
      notice.hidden = true;
      root.replaceChildren(view.element, notice);
      canvas.hidden = false;
      appMounted = true;
      await mountRun(current, version);
      return;
    }

    const dropzone = createDropzone({
      store: current,
      onModel: (model, fileName) => {
        dropped = model;
        droppedName = fileName;
        scheduleRestart();
      },
    });
    report = createForceReport();
    comparePanel = createComparePanel({ onFile: (file) => void compareWithFile(file) });
    notice = document.createElement('p');
    notice.id = 'run-status';
    notice.setAttribute('role', 'status');
    notice.hidden = true;
    const runFile = createRunFileControl((file) => {
      const mounted = appMounted;
      appMounted = false;
      current.replace(settingsOfRun(file));
      disposeRun();
      appMounted = mounted;
      loadedRun = file;
      canvas.hidden = true;
      report?.update(runFileReport(file));
      setNotice(`Showing the saved run ${file.name}. Change a setting to start a new run.`);
    });
    const share = createShare(current);
    const panel = createPanel({
      store: current,
      dropzone: dropzone.element,
      onCheckGrid: () => void checkGrid(),
    });
    const footer = panel.querySelector('footer');
    root.replaceChildren(
      chapter(
        'experiment',
        'The experiment',
        'Change the body, its size or the air speed. Each change exposes a new plate.',
        notice,
        panel,
      ),
      chapter('record', 'The record', null, report.element, comparePanel.element),
      chapter(
        'keep',
        'Keep this plate',
        null,
        share,
        createEmbedControl({ store: current }),
        runFile,
      ),
      ...(footer ? [footer] : []),
    );
    caption = createPlateCaption();
    mountCaption(caption, dropzone.input);
    canvas.hidden = false;

    appMounted = true;
    await mountRun(current, version);
  }

  /** Put the caption on the plate and let the whole plate take a dropped model. */
  function mountCaption(
    plateCaption: ReturnType<typeof createPlateCaption>,
    input: HTMLInputElement,
  ): void {
    const plate = canvas.parentElement;
    plate?.append(plateCaption.overlay, plateCaption.element);
    if (expose) {
      expose.hidden = false;
      expose.onclick = () => input.click();
    }
    if (plate === null) return;
    plate.ondragover = (event) => {
      event.preventDefault();
      plate.classList.add('plate--receiving');
    };
    plate.ondragleave = () => plate.classList.remove('plate--receiving');
    plate.ondrop = (event) => {
      event.preventDefault();
      plate.classList.remove('plate--receiving');
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      input.files = files;
      input.dispatchEvent(new Event('change'));
    };
  }

  function resetRouteState(): void {
    appMounted = false;
    restartQueued = false;
    if (liveTimer !== undefined) {
      clearTimeout(liveTimer);
      liveTimer = undefined;
    }
    disposeRun();
    loadedRun = undefined;
    report = undefined;
    embedReadout?.dispose();
    embedReadout = undefined;
    comparePanel?.dispose();
    comparePanel = undefined;
    caption?.element.remove();
    caption?.overlay.remove();
    caption = undefined;
    if (expose) expose.hidden = true;
    // A framed plate links back to the full tunnel; the site's own navigation stays out of it.
    if (masthead) masthead.hidden = isEmbedRoute();
    notice = undefined;
    root.replaceChildren();
    canvas.hidden = true;
  }

  async function mountTunnel(version: number): Promise<void> {
    support ??= detectGpu('gpu' in navigator ? navigator.gpu : undefined);
    const result = await support;
    if (version !== routeVersion) return;
    if (result.status === 'unsupported') {
      if (isEmbedRoute()) renderEmbedUnsupported(root, result.reason, location.href);
      else renderUnsupported(root, result.reason, navigator.userAgent);
      return;
    }
    gpu = result;
    await mountApp(version);
    if (version !== routeVersion) return;

    if (result.tierPolicy === 's-only') {
      const tierNotice = document.createElement('p');
      tierNotice.setAttribute('role', 'status');
      tierNotice.textContent = `${MESSAGES['tier-s-only'].what} ${MESSAGES['tier-s-only'].next}`;
      root.append(tierNotice);
    }
  }

  async function renderRoute(): Promise<void> {
    const version = ++routeVersion;
    resetRouteState();

    const route = currentRoute();
    if (route === 'validate') {
      await renderValidateRoute(root, () => version === routeVersion);
      return;
    }
    if (route === 'bench') {
      const controller = new AbortController();
      routeAbort = controller;
      await renderBenchRoute(root, controller.signal);
      return;
    }
    if (isUnattended(location.hash)) {
      await runUnattended(root, location.hash);
      return;
    }
    await mountTunnel(version);
  }

  watchRoute(() => {
    void renderRoute();
  });
}
