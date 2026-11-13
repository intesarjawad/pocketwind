# Make it yours

The interface is a static site with no server and no accounts. Two places cover
most changes.

## Presets

Built-in presets live in `src/app/params.ts`. Each entry has an `id`, a name and
a body length in millimetres. Add an entry there and the preset menu and share
links pick it up. A preset's geometry belongs with the rest of the model
importing code; the id is only the label that links and run files keep.

## Defaults

`DEFAULT_SETTINGS` in `src/app/params.ts` holds the initial size, speed,
orientation, solver choices and placement. The Advanced summary counts how many
of its four solver choices differ from those defaults, so changing a default
changes both the form and the count.

## Run file

"Export run" in the share controls writes `<name>-run.json`: one flat JSON
object, indented by two spaces. "Open a saved run" reads it back and refuses
files over 5 MB, text that is not a JSON object, an unknown `schemaVersion` and
any missing or mistyped field, each with its own message and never an
exception. The current `schemaVersion` is 3.

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | number | Layout of this file. |
| `name` | string | Label used for the file name. |
| `presetId` | string | Preset id, or `custom` for a dropped model; the model file is never embedded. |
| `tier` | string | `auto`, `S`, `M`, `L` or `XL`, as chosen. |
| `storage` | string | `auto`, `f32` or `f16`. |
| `operator` | string | `trt` or `reg`. |
| `walls` | string | `bb` or `bouzidi`. |
| `speedMps` | number | Free-stream speed in metres per second. |
| `bodyLengthMm` | number | Body length in millimetres. |
| `flowAxis` | string | `x`, `y` or `z`. |
| `flowSign` | number | `1` or `-1`. |
| `upAxis` | string | `x`, `y` or `z`, different from `flowAxis`. |
| `floor` | boolean | Whether the tunnel floor is present. |
| `paused` | boolean | Whether the view was paused. |
| `compare` | object | `{ "enabled": boolean }`, the comparison view state. |
| `cd` | number or null | Drag coefficient on the stated reference area; null while settling. |
| `cdaM2` | number or null | Cd times the reference area, in square metres. |
| `dragForceN` | number or null | Drag force in newtons at `speedMps`. |
| `status` | object | `settling` with `etaS`, or `steady` or `unsteady` with `relStdPct` and `driftPct`. |
| `fluctuationPct` | number or null | Relative standard deviation of Cd; null while settling. |
| `semPct` | number or null | Standard error of the mean Cd, in percent. |
| `grid` | object | Cells per axis, `{ "nx": number, "ny": number, "nz": number }`. |
| `referenceAreaRule` | string | `preset` for the preset's stated frontal area, `frontal` for projected solid cells. |
| `forceHistory` | array | Cd samples as `[step, cd]` pairs. |
| `fy` | number or null | Latest lateral force coefficient on the same reference area. |
| `fz` | number or null | Latest vertical force coefficient on the same reference area. |
| `unvalidated` | array | Components with no validated reference: `fy` and `fz`. |
| `commit` | string | Source commit of the build, `dev` for an unstamped build. |
| `numericsHash` | string | SHA-256 over the solver sources, from `scripts/numerics-hash.sh`, `dev` for an unstamped build. |

`fy` and `fz` are recorded for inspection only; no reference case checks them.
Builds are stamped with `VITE_COMMIT` and `VITE_NUMERICS_HASH`, as `npm run
prepack` does.

### Comparing with a saved run

The tunnel can take a run file as the first run of a comparison, with the
current model as the second. The file is refused before the second run starts
when its resolved tier, `speedMps` or `referenceAreaRule` differ from the
current run, or when its `numericsHash` differs from the build's. A different
`commit` alone is accepted, because styles, copy and dependencies do not change
the solver. The panel reports the change in CdA as a percentage with a band of
twice the combined standard error; a change inside the band names no winner. The
band covers sampling only, so both runs must use the same grid.

## Share links

A link has the form `#/<route>?<params>`. The routes are the tunnel (empty),
`validate` and `bench`. These parameters set the run; any other name is ignored
with a console warning.

| Param | Setting | Values |
| --- | --- | --- |
| `p` | `presetId` | A preset id, `custom` or `none` (empty tunnel with the smoke rake) |
| `t` | `tier` | `auto`, `S`, `M`, `L`, `XL` |
| `st` | `storage` | `auto`, `f32`, `f16` |
| `op` | `operator` | `trt`, `reg` |
| `w` | `walls` | `bb`, `bouzidi` |
| `v` | `speedMps` | Number, clamped to 5 to 60 |
| `len` | `bodyLengthMm` | Positive number |
| `ax` | `flowAxis` | `x`, `y`, `z` |
| `sg` | `flowSign` | `1`, `-1` |
| `up` | `upAxis` | `x`, `y`, `z` |
| `fl` | `floor` | `0`, `1` |

`cam`, `record`, `embed`, `auto`, `stopAt`, `re`, `les`, `lc`, `inject_nan`,
`gcT`, `gc`, `ramp`, `tiers` and `steps` are read by the camera, the run or a
results route and are not part of the settings. A link never carries a dropped
model file or the comparison view, so a `custom` link says that it excludes the
file.

## Running locally

Follow [CONTRIBUTING](../CONTRIBUTING.md): `npm ci`, `npm run dev`, then
`npm run check` before sharing a change.
