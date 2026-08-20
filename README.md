# YomagAudio

**A transit system for your audio.**

YomagAudio is a Windows desktop application for routing, mixing, and
monitoring audio between hardware devices, running applications, and other
machines on the network — the same job as macOS's *Loopback* or Windows
tools like *Voicemeeter*, built from scratch for a cleaner, more direct
routing model and a modern UI.

You create one or more **virtual devices**. Each one pulls in audio from any
number of **sources** (a physical microphone, a running application's audio,
or a device published by another YomagAudio instance on the network), mixes
those sources down onto its own output channels, and optionally forwards
("monitors") those channels out to real speakers/headphones — all with
per-source gain/mute, per-channel routing, and per-monitor buffering, delay,
and parametric EQ. Any device can also be **recorded** — every source
captured to its own track — and edited afterward in a built-in multitrack
editor (trim, split, move, per-track gain/mute/solo/EQ) before exporting a
final mixdown.

**[⬇ Download YomagAudio v0.1.0 for Windows x64](https://github.com/Yomag84/yomag-audio/releases/download/v0.1.0/YomagAudio_0.1.0_x64-setup.exe)**
— installer, no separate driver download needed (see
[Getting started](#getting-started) for what the driver bundling does and
doesn't do). All [releases](https://github.com/Yomag84/yomag-audio/releases).

---

## Contents

- [Feature overview](#feature-overview)
- [Architecture](#architecture)
- [Technology stack](#technology-stack)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Using the app](#using-the-app)
- [Recording & editing](#recording--editing)
- [Design system](#design-system)
- [IPC command reference](#ipc-command-reference)
- [Data model](#data-model)
- [Network protocol](#network-protocol)
- [Profiles & persistence](#profiles--persistence)
- [Status & known limitations](#status--known-limitations)
- [Community & support](#community--support)
- [License](#license)

---

## Feature overview

| Area | Capability |
|---|---|
| **Routing** | Create any number of virtual devices; wire individual source channels to individual output channels with a click-to-connect cable UI; live per-channel level meters |
| **Sources** | Physical input devices, any running application's audio (process-loopback capture), or a peer's published device over the network |
| **Mixing** | Per-source gain and mute; devices grow their output channel count in stereo pairs on demand |
| **Monitoring** | Forward a virtual device's output channels to one or more real output devices, with independent buffer size, output delay, WASAPI exclusive-mode option, and a multi-band parametric EQ per monitor |
| **Applications view** | See every process currently playing audio and route it straight to any virtual device as a destination, without hunting for it in the routing graph |
| **Network** | Publish a virtual device's mix to the LAN; discover peers automatically; pull a peer's published device in as a source; optionally create real Windows audio endpoints (via the bundled kernel driver) that any app can select directly |
| **Profiles** | Save the entire routing graph to disk and reload it later, or restore it automatically on next launch |
| **Recording** | Record every current source of a virtual device to its own WAV file with one click — a true multitrack take, not just a mixed-down file |
| **Editing** | A dedicated multitrack editor per recording: trim, split, move, and delete clips; per-track gain/mute/solo; a per-track parametric EQ rack; export to a final mixdown WAV |
| **System integration** | System tray icon (minimize-to-tray instead of quitting), native File/View/Device/Help menu, first-run auto-setup that wires an internal mic to an internal speaker when it can detect both |
| **Appearance** | Full light and dark themes with a persisted, OS-aware toggle |

## Architecture

YomagAudio is a **Tauri 2** desktop app: a native Windows shell hosting a
React UI, backed by a Rust audio engine. There is no HTTP server and no
external process — UI and engine share one process, talking over Tauri's
IPC (`invoke` calls from React, typed command handlers in Rust) plus one
push channel (`audio://levels`) for live meter data.

```
┌───────────────────────────────────────────────────────────────────┐
│  React UI  (src-ui)                                               │
│  Routing / Applications / Network views · Settings · theming      │
└───────────────────────────┬───────────────────────────────────────┘
                            │ tauri.invoke("command", args)
                            │ listen("audio://levels" / "menu://…")
┌───────────────────────────▼───────────────────────────────────────┐
│  Tauri command layer  (src-tauri/src/commands)                    │
│  Thin #[tauri::command] wrappers around the Router                │
└───────────────────────────┬───────────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────────┐
│  Audio engine  (src-tauri/src/audio)                              │
│  Router — owns every virtual device, source, connection, and      │
│  monitor; runs the real-time mixer tick; snapshots state for the  │
│  UI and for profile save/load                                     │
│                                                                     │
│  ├─ device_manager   physical device enumeration (cpal)           │
│  ├─ loopback         WASAPI capture from physical inputs          │
│  ├─ process_audio    per-process audio capture (Win10 2004+ API)  │
│  ├─ exclusive_output WASAPI exclusive-mode monitor output         │
│  ├─ eq               RBJ biquad parametric EQ per monitor          │
│  ├─ resampler        cubic-Hermite sample-rate conversion          │
│  ├─ mmcss            "Pro Audio" thread priority for every RT thread│
│  ├─ network          UDP peer discovery + audio streaming          │
│  ├─ recording        per-source WAV capture, non-destructive edit  │
│  │                   list, offline mixdown render                  │
│  └─ system_device    binds new endpoints to the kernel driver      │
└───────────────────────────┬───────────────────────────────────────┘
                            │ WASAPI (shared or exclusive mode)
┌───────────────────────────▼───────────────────────────────────────┐
│  Windows audio subsystem + YomagAudioDriver.sys                   │
│  (ACX virtual audio cable — driver/YomagAudioDriver)               │
└─────────────────────────────────────────────────────────────────────┘
```

Key design decisions baked into the engine:

- **One mixer tick drives everything.** The `Router`'s real-time thread
  reads from every source's ring buffer, applies gain/mute, resamples to a
  shared internal rate, sums onto each virtual device's output channels,
  and writes into every monitor's output ring buffer — once per tick, at a
  5ms period, on an MMCSS "Pro Audio"-promoted thread.
- **Every clock mismatch is resampled**, not assumed away: a mic's native
  rate to the internal mix rate, and the internal mix rate back out to
  whatever rate a monitor's real output device wants, via a streaming
  cubic-Hermite resampler chosen over linear interpolation specifically for
  its better stopband rejection (linear measurably aliased high-frequency
  content into audible noise in testing).
- **`windows::Win32::Media::timeBeginPeriod(1)` is held for the process's
  whole lifetime.** Windows' default 15.6ms timer granularity would silently
  round up every 5-10ms sleep in the mixer/capture/network threads,
  starving downstream buffers — this is what keeps a "5ms tick" honest.
- **The dev build isn't fully unoptimized.** `Cargo.toml` sets
  `opt-level = 1` for this crate and `opt-level = 3` for dependencies in the
  `dev` profile, because an `opt-level = 0` debug build can't reliably hit
  the mixer's 5ms deadline — audible as crackling, not a logic bug.
  Incremental compilation is also disabled for this crate on this
  toolchain/linker combination, which otherwise fails deterministically
  with `LNK2019` errors.

## Technology stack

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | [Tauri 2](https://tauri.app/) | Native window + IPC bridge, far smaller footprint than Electron |
| UI | React 18 + TypeScript, Vite | Fast dev loop, typed IPC payloads shared via `types.ts` |
| Styling | Plain CSS with custom properties (no framework) | Small app surface; a themed token system covers it without a build-time CSS framework |
| Engine language | Rust (edition 2021) | Real-time audio work under hard latency budgets; safe concurrency for the mixer/capture/network threads |
| Audio I/O | [`cpal`](https://docs.rs/cpal) for enumeration + the `windows` crate directly for WASAPI (shared and exclusive mode), process-loopback capture, and MMCSS | `cpal` covers portable enumeration; the exclusive-mode and per-process capture paths need direct WASAPI/COM control `cpal` doesn't expose |
| Ring buffers | [`ringbuf`](https://docs.rs/ringbuf) | Lock-free SPSC buffers between capture/mix/output threads |
| WAV I/O | [`hound`](https://docs.rs/hound) | Pure-Rust WAV read/write; its 32-bit float PCM format matches the engine's internal sample format with zero conversion |
| Multitrack preview | Web Audio API (`AudioContext`, `AudioBufferSourceNode`, `GainNode`, `BiquadFilterNode`) | Native browser DSP for live editor playback/scrub/EQ preview, so the frontend needs no audio-processing library of its own — the authoritative render still happens in Rust |
| Concurrency | `parking_lot`, `arc-swap`, `tokio` | Low-overhead locking for shared state; async runtime for network I/O |
| Kernel driver | C++ ACX (Audio Class eXtension) on KMDF (`driver/YomagAudioDriver`) | The only way to expose a device that *any* Windows app can select directly, not just apps YomagAudio can hook into |
| CI | GitHub Actions (`.github/workflows/build.yml`) | `cargo test` + `npm run tauri:build` on `windows-latest`, installer artifacts uploaded per run |
| Packaging | Tauri bundler → MSI + NSIS installers | Standard Windows distribution formats |

## Project structure

```
yomag-audio/
├─ src-ui/                     React frontend (dev root — see vite.config.ts)
│  ├─ src/
│  │  ├─ App.tsx                Top-level state, view switching, theme
│  │  ├─ App.css                Header, nav tabs, buttons, dialogs
│  │  ├─ index.css              Design tokens (light/dark), global reset
│  │  ├─ types.ts               TypeScript mirror of the Rust IPC types
│  │  ├─ hooks/useDeviceLevels.ts   Subscribes to the audio://levels event
│  │  ├─ lib/
│  │  │  ├─ editorEngine.ts      Web Audio multitrack playback/preview engine
│  │  │  ├─ waveform.ts          Peak computation + canvas waveform drawing
│  │  │  └─ trackColors.ts       Deterministic per-track color (waveform + mixer strip agree)
│  │  └─ components/
│  │     ├─ Sidebar.*            Virtual device list
│  │     ├─ RoutingPanel.*       Sources ↔ output channels ↔ monitors graph
│  │     ├─ MonitorSettingsPanel.* Buffer/delay/EQ controls for one monitor
│  │     ├─ ApplicationsPanel.*  Per-process audio routing
│  │     ├─ NetworkPanel.*       Publish / discover / receive / system endpoints
│  │     ├─ SettingsDialog.*     Device table, engine info, monitor overview
│  │     ├─ RecordingsPanel.*    Recording library grid + search
│  │     ├─ RecordingDetailModal.* Combined waveform playback, rename/delete
│  │     └─ editor/              Multitrack editor (see Recording & editing)
│  │        ├─ EditorPage.*       Page shell: Main/Mixer tabs, loads tracks, owns project state
│  │        ├─ TransportBar.*     Play/pause/stop/zoom/save/export
│  │        ├─ TrackLane.*        Main tab: one track's header (mute/solo/gain/FX) + canvas
│  │        ├─ ClipCanvas.tsx     Per-track waveform + drag-to-trim/move/select
│  │        ├─ MixerView.*        Mixer tab: one channel strip per track (pan/fader/mute/solo/FX)
│  │        ├─ Knob.*             Small drag-to-adjust rotary control, used for pan
│  │        └─ EffectsRack.*      Per-track parametric EQ popover, shared by both tabs
│  └─ index.html
├─ src-tauri/                  Rust backend + Tauri shell
│  ├─ src/
│  │  ├─ main.rs                 App bootstrap, tray, native menu, level-emit loop
│  │  ├─ state/mod.rs             AppState (the shared Router handle)
│  │  ├─ commands/audio.rs       #[tauri::command] surface exposed to the UI
│  │  ├─ commands/recording.rs   #[tauri::command] surface for recording/editing
│  │  └─ audio/                  The engine (see Architecture above)
│  ├─ tauri.conf.json            Window, bundler, dev-server config
│  └─ capabilities/default.json  Tauri permission manifest
├─ driver/YomagAudioDriver/     Kernel-mode virtual audio cable (C++, ACX/KMDF)
├─ community/                   Discord server setup script (see community/README.md)
├─ .github/workflows/build.yml  CI: test + build + upload installer
├─ .github/FUNDING.yml          Powers the repo's native "Sponsor" button
├─ package.json / vite.config.ts / tsconfig*.json
```

## Getting started

### Download (prebuilt installer)

**[Download YomagAudio v0.1.0](https://github.com/Yomag84/yomag-audio/releases/download/v0.1.0/YomagAudio_0.1.0_x64-setup.exe)**
— a single NSIS installer, no separate driver download. It also carries the
optional kernel driver's files (see [The kernel driver](#the-kernel-driver-optional-advanced)
below) but does **not** install, sign, or load them — you'll see a one-time
warning dialog during setup explaining that, and every feature except
*Local Network Devices* works with nothing further needed.

### Prerequisites

- **Windows 10/11**, x86-64 (the engine and driver are Windows-only)
- **Node.js 20+** and npm
- **Rust** (stable toolchain) with the MSVC target
- **WDK/Visual Studio Build Tools** — only if you intend to build the
  kernel driver in `driver/YomagAudioDriver`; the app itself builds without it

### Run in development

```bash
npm install
npm run tauri:dev
```

This starts the Vite dev server (`npm run dev`, port 5173) and launches the
Tauri window pointed at it, with hot reload for the UI. On first launch the
window's devtools open automatically in debug builds.

You can also run the UI alone in a browser (`npm run dev`) for pure
CSS/layout iteration — every `invoke()` call will reject since there's no
Tauri host, but components degrade to their empty states rather than
crashing, so header/nav/theme changes are still visible.

### Build an installer

```bash
npm run tauri:build
```

Produces an NSIS installer at
`src-tauri/target/release/bundle/nsis/YomagAudio_<version>_x64-setup.exe`
(MSI is not built — see below for why). The same command runs in CI on
every push/PR to `main`/`develop` (see `.github/workflows/build.yml`),
alongside `cargo test` from `src-tauri/`.

The installer bundles the app's icon and a splash screen (both generated
from the YomagAudio logo — `src-tauri/icons/`, `src-ui/splashscreen.html`,
shown in its own borderless window while the main app loads, see
`main.rs`'s `setup()`), plus the driver's `.sys`/`.inf` as ordinary bundle
resources (`bundle.resources` in `tauri.conf.json`) under `driver/` in the
install directory. **Only NSIS is targeted**, not MSI/WiX: the mandatory
driver warning dialog (`src-tauri/installer-hooks.nsh`, hooked in via
`bundle.windows.nsis.installerHooks`) needs NSIS's scripting; WiX doesn't
have an equivalent lightweight customization point in this setup. The
warning is skipped automatically for silent/unattended installs (`/S`) —
see the `IfSilent` check in that `.nsh` file.

Rebuilding the driver files the installer bundles (they're **not**
produced by `npm run tauri:build` itself) is a separate manual step:

```powershell
& "C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\amd64\MSBuild.exe" `
  driver\YomagAudioDriver\YomagAudioDriver.vcxproj /p:Configuration=Release /p:Platform=x64 /p:SignMode=Off
```

(see `driver/YomagAudioDriver/README.md` for why `/p:SignMode=Off` is
needed). `tauri.conf.json`'s `bundle.resources` points at that build's
fixed output path (`driver/YomagAudioDriver/x64/Release/`), so it has to
exist before `npm run tauri:build` runs.

### The kernel driver (optional, advanced)

The driver lets YomagAudio create real Windows audio endpoints (Network
view → *Local Network Devices*) that any application can select directly,
the way a physical sound card would appear. Building it requires the WDK;
see `driver/YomagAudioDriver/README.md`.

> **This driver has never been installed or loaded on a real machine.** It
> compiles cleanly against the WDK, which confirms it's structurally sound,
> but a kernel-mode bug is a materially different risk than a bug anywhere
> else in this project — up to and including a machine crash. If you build
> and load it, **do it in a VM first.**
>
> The installer above places the driver's files on disk (so you don't need
> a separate download to try it) but deliberately stops there — it does
> not enable Windows test-signing mode, sign the driver, or load it. Those
> remain the same deliberate, manual steps documented in
> `driver/YomagAudioDriver/README.md`'s "What's left before this can
> actually run" section.

## Using the app

1. **Routing** (default view) — pick or create a virtual device in the
   left sidebar. Add sources and output channel pairs, then click a
   source's channel dot followed by an output channel's dot to connect
   them (click either dot again to cancel a pending connection). Toggle
   **Show Monitors** to reveal a third column for wiring output channels
   out to real devices, each with its own buffer/delay/EQ and an optional
   WASAPI exclusive-mode switch for devices whose full channel count only
   shows up in exclusive mode.
2. **Applications** — every process currently producing audio shows up
   here with a checkbox per virtual device; check one to route that app's
   audio straight in as a source, with inline gain/mute.
3. **Network** — publish a device so other YomagAudio instances on the LAN
   can pull it in; peers you discover appear automatically with whatever
   they're publishing; optionally create a real system audio endpoint
   (requires Administrator privileges and the driver already installed).
4. **Settings** (gear button, or `Ctrl+,`) — a read-only-ish overview: every
   physical device with its in-use status, current engine sample
   rate/tick period, and every monitor's buffering settings in one table.
5. **Record** — from the Routing view's toolbar, with a virtual device
   selected: hit **Record** to capture every one of its current sources
   to its own file, then **Stop** to finish. You land in the **Recordings**
   view with that take's detail modal already open — see
   [Recording & editing](#recording--editing) for what happens next.
6. **File menu** — new device (`Ctrl+N`), save/load profile (`Ctrl+S` /
   `Ctrl+O`), settings, quit. **View menu** switches tabs and refreshes
   devices (`Ctrl+R`). Closing the window hides it to the tray rather than
   quitting — the mixer keeps running in the background; use tray icon
   → *Quit* or the menu's Quit (`Ctrl+Q`) to actually exit.

## Recording & editing

**Capture.** Hitting Record on a virtual device snapshots its *current*
sources and gives each one its own dedicated WAV writer thread, tapping
post-gain, pre-mute audio straight out of the mixer tick
(`SourceEntry::record_tap` in `engine.rs`) — so a gain change you make to
compensate for a quiet source reaches the file, while a source you mute
mid-take is still fully captured (muting only silences live monitoring/mix
output, not the recording). A source added after Record was pressed gets
no track; a source removed
mid-take has its track finalized immediately rather than orphaned. Each
session lands in `<app data dir>/recordings/<session_id>/` as
`manifest.json` (the immutable facts of the take: device, tracks, sample
rate, duration) plus one `track_<source>.wav` per source.

**Library.** The **Recordings** view lists every session (search by name
or device); its detail modal decodes every track, plays them back
together as a live mix, and lets you rename, delete, or **Open in
Editor**.

**Editing.** The multitrack editor is non-destructive: your edits — trim,
split, move, delete clips; per-track gain/pan/mute/solo; a per-track
parametric EQ — are a plain edit list (`project.json`), never a mutation
of the original WAVs. It's a two-tab page:

- **Main** — one lane per track (`TrackLane`/`ClipCanvas`), each colored
  consistently between its waveform and its Mixer strip
  (`lib/trackColors.ts`, hashed from the track's source id so the mapping
  never needs to be stored). Drag a clip's body to move it, drag an edge
  to trim, use **Split** to cut the clip under the playhead in two, and
  **Delete** to remove the selected one.
- **Mixer** — one channel strip per track: a pan knob (drag up/down to
  adjust, double-click to re-center), a vertical gain fader, Mute/Solo,
  and an **FX** button opening the same parametric-EQ rack as the Main
  tab. Both tabs edit the identical `TrackProject` state, so a change on
  one is immediately reflected on the other.

Live preview of all of this runs entirely in the browser via the Web
Audio API (`src-ui/src/lib/editorEngine.ts`): one `AudioBufferSourceNode`
per visible clip, one `GainNode` + `StereoPannerNode` per track, and
native `BiquadFilterNode`s (`"peaking"` mode) standing in for the real EQ
during preview. **Export Mixdown** is the one operation that calls back
into Rust: `recording::render_mixdown` replays the same edit list offline
using the engine's actual `MultibandEq`/soft-limiter DSP and a matching
balance-style pan law — the same code path monitors use — so the exported
file matches the app's real sound, not the browser's approximation, and
writes a stereo WAV to `<session>/mixdown/`. (Mixdown is always 2-channel:
a mono track duplicates to both channels before panning, a track with
more than 2 channels contributes only its first two.)

The playhead is always clamped to the end of the arrangement (the
furthest `timeline_start_frame + length_frames` across every clip) —
playback automatically stops and parks there instead of running on past
the last real audio, and manual seeks/clicks can't push it further either.

## Design system

The UI ships **light and dark themes**, switched by the sun/moon control in
the header (defaults to the OS's `prefers-color-scheme`, then remembers
your choice in `localStorage`). Every visual value is a CSS custom property
defined once in `src-ui/src/index.css` under `:root` (light) and
`:root[data-theme="dark"]` (dark overrides) — components never hardcode a
color, so both themes stay in sync automatically as the UI evolves.

| Token | Role |
|---|---|
| `--bg-app` / `--bg-surface` / `--bg-surface-alt` / `--bg-surface-sunken` | Page background → card surface → inset control background → deepest well (in increasing "recessed-ness") |
| `--border` / `--border-strong` | Default hairline vs. emphasized/hover borders |
| `--text-primary` / `--text-secondary` / `--text-muted` | Heading/body → secondary body → captions/hints |
| `--accent` / `--accent-strong` / `--accent-soft` / `--accent-gradient` | Brand violet — solid, hover, tinted background, and the gradient used on the header and primary buttons |
| `--accent2` / `--accent2-strong` / `--accent2-soft` | Secondary teal accent, scoped to Recordings/editor waveform and transport chrome only — `--accent` stays the brand color everywhere else |
| `--success` / `--danger` / `--warning` (+ `-soft` variants) | Status color for meters, badges, toggles, and stream-health warnings |
| `--shadow-sm` / `--shadow-md` / `--shadow-lg` | Elevation, from a resting card to a modal dialog |
| `--radius-sm` / `--radius-md` / `--radius-lg` / `--radius-pill` | Corner rounding, from inputs up to pill-shaped chips/tabs/toggles |

Visual language:

- **Header** is a violet→magenta gradient hero carrying the app mark, title,
  and the theme switch — the one place in the UI that's always "on brand"
  regardless of theme.
- **Navigation** is a pill-shaped segmented control rather than underlined
  tabs; the active view fills with the accent gradient.
- **Cards** (routing cards, app session cards, network sections) share one
  visual treatment: `var(--bg-surface)`, a hairline border, `var(--radius-md)`,
  and `var(--shadow-sm)` — consistent enough that new panels can reuse the
  same classes instead of inventing new card chrome.
- **Chips** (destination toggles, network items) use `--radius-pill` and
  switch to a tinted `--accent-soft` background plus an accent border when
  active/routed, so routed-vs-not is readable at a glance without relying
  on color alone (the checkbox state carries the same information).
- **Level meters** keep one universal gradient
  (`--success → --warning → --danger`) regardless of theme, since a meter's
  color coding is a learned convention users shouldn't have to re-learn
  between light and dark mode.

To restyle: change the token values in `index.css`; you should not need to
touch a component's `.css` file to reskin it. To add a new themed value,
add it as a token pair (light default + dark override) rather than a raw
color, so it participates in the toggle automatically.

## IPC command reference

Commands are defined in `src-tauri/src/commands/audio.rs` and
`commands/recording.rs`, and registered in `main.rs`'s `invoke_handler!`.
Grouped by area:

**Device discovery**
`list_devices` · `list_audio_sessions` · `guess_internal_devices` ·
`get_engine_info`

**Virtual devices**
`list_virtual_devices` · `create_virtual_device` · `delete_virtual_device` ·
`rename_virtual_device` · `set_device_enabled` ·
`set_device_output_channels`

**Sources**
`add_device_source` · `remove_device_source` · `set_device_source_gain` ·
`set_device_source_muted`

**Connections** (source channel → output channel)
`set_connection` · `remove_connection`

**Monitors** (output channel → real device)
`add_monitor` · `remove_monitor` · `set_monitor_channel` ·
`clear_monitor_channel` · `set_monitor_exclusive` ·
`set_monitor_buffer_ms` · `set_monitor_delay_ms` · `set_monitor_eq`

**Profiles**
`save_profile` · `load_profile` · `has_saved_profile`

**Network**
`create_system_endpoint` · `remove_system_endpoint` ·
`list_system_endpoints` · `list_peers` · `set_device_published` ·
`add_network_source`

**Recording capture**
`start_recording` · `stop_recording` · `list_recordings` ·
`rename_recording` · `delete_recording`

**Recording editing**
`get_recording_manifest` · `recording_file_path` ·
`load_recording_project` · `save_recording_project` · `render_mixdown`

The frontend also **listens** for two event streams:
`audio://levels` (emitted every 100ms with every device's live meter data)
and `menu://*` (native File/View/Device/Help menu clicks, forwarded so the
frontend — which owns all routing state — can decide what each means).

## Data model

Mirrored 1:1 between `src-tauri/src/audio/engine.rs` (Rust, source of
truth) and `src-ui/src/types.ts` (TypeScript, IPC payload shape):

- **`VirtualDeviceSnapshot`** — id, name, enabled, `output_channels`, its
  `sources: SourceInfo[]`, `connections: Connection[]`, `monitors:
  MonitorInfo[]`, and `is_published`.
- **`SourceInfo`** — an input feeding a device: `id` (a physical device
  name, `app:<pid>:<process_name>`, or `net:<peer_id>:<remote_device_id>`),
  channel count, gain, muted.
- **`Connection`** — one wire: `source_id` + `source_channel` →
  `output_channel`, with its own gain.
- **`MonitorInfo`** — a real output device a virtual device forwards to:
  `channel_map` (output channel per monitor channel, or `null`),
  `exclusive` mode flag, `buffer_ms`, `delay_ms`, and `eq_bands: EqBand[]`.
- **`EqBand`** — `freq_hz` / `gain_db` / `q` for one RBJ parametric peaking
  filter.
- **`DeviceLevels`** — per-device live meter data: per-source and output
  peak levels, plus `StreamStats` (`underruns` / `overruns` / `buffered_ms`)
  per source and monitor, used for the small warning badge on a card when a
  stream is struggling.

Mirrored 1:1 between `src-tauri/src/audio/recording.rs` and `types.ts`,
the recording/editing side:

- **`RecordingManifest`** — the immutable record of one take: session id,
  device id/name, display name, `created_at_ms`, and `tracks:
  TrackManifest[]`. Written once by `stop_recording`, never rewritten by
  the editor.
- **`TrackManifest`** — one captured file: `source_id`, `file` (its WAV's
  filename within the session directory), `channels`, `sample_rate`,
  `duration_frames`.
- **`RecordingSummary`** — the lightweight DTO `list_recordings` returns
  for the library grid: id, name, device name, `created_at_ms`,
  `duration_ms`, `track_count`.
- **`RecordingProject`** — the editable state for one session: `tracks:
  TrackProject[]`. Persisted to `project.json`; synthesized as a default
  (one full-length clip per track, unity gain, centered pan, no EQ) the
  first time a session is opened.
- **`TrackProject`** — one track's edit state: `source_id`, `gain`, `pan`
  (-1 full left .. 1 full right, 0 = center), `muted`, `solo`,
  `eq_bands: EqBand[]`, `clips: Clip[]`.
- **`Clip`** — one placed region: `source_start_frame` + `length_frames`
  (which slice of the *source* WAV) at `timeline_start_frame` (where it
  sits on the shared timeline). Trim shrinks the range; split replaces one
  clip with two; move changes `timeline_start_frame`; delete drops it.

## Network protocol

A deliberately simple, LAN-only UDP protocol (`src-tauri/src/audio/network.rs`)
with no external discovery dependency (no mDNS/Bonjour):

- **Beacon port** — every instance broadcasts "I exist, here's what I
  publish" every 2 seconds and listens for the same from others. This is
  how the Network view's peer list populates itself with no configuration.
- **Control port** — a peer that wants to receive a published device sends
  a small "subscribe" datagram naming the device and the UDP port it wants
  audio delivered to; it re-sends this every few seconds as a keepalive.
  There's no explicit unsubscribe — a stale keepalive just expires out of
  the publisher's listener set.
- **Audio delivery** happens directly, peer to peer, once subscribed.

## Profiles & persistence

`save_profile` serializes the router's entire state (every virtual device,
source, connection, and monitor) to `profile.json` in the app's data
directory as pretty-printed JSON. `load_profile` reads it back and
re-applies it wholesale. `has_saved_profile` just checks whether that file
exists, which is what gates the first-run auto-setup (see below) and the
enabled state of the *Load Profile* button.

This is entirely separate from recording sessions (`<app data dir>/recordings/`,
see [Recording & editing](#recording--editing)) — a routing profile is
your live device/source/monitor graph; a recording session is a captured
take plus its edit list. Neither one touches the other.

**First-run convenience:** if there's no saved profile and no virtual
device already exists, the app tries to guess an internal microphone and
internal speaker and wires up a 2-channel "Internal Mic + Speaker" device
automatically — but leaves it **disabled**, since an internal mic sitting
next to an internal speaker is a real acoustic-feedback risk you should
opt into, not wake up to.

## Status & known limitations

- The **kernel driver** compiles but has not been installed, loaded, or
  tested on real hardware — see the warning in
  [Getting started](#getting-started). Every other feature (routing,
  applications, network) works without it; the driver is only required for
  the *Local Network Devices* system-endpoint feature.
- The UI targets a single-window desktop session; there's no multi-window
  or multi-monitor-specific layout.
- The network protocol is LAN-only by design — there is no NAT traversal,
  authentication, or encryption. Treat it as trusted-network-only.
- **Mixdown export is always 2-channel.** A mono track duplicates to both
  channels; a track with more than 2 channels only contributes its first
  two. Every individual `track_*.wav` still keeps its original channel
  count — only the combined export is fixed at stereo.
- **The editor decodes every track fully into memory** (`AudioContext.
  decodeAudioData`) rather than streaming — fine for typical multitrack
  takes, but a very long recording (many hours) would need a streaming
  decode path this version doesn't have.
- A recording captures whatever sources existed on the device **when
  Record was pressed** — a source added mid-take gets no track; a source
  removed mid-take has its track finalized at that point rather than
  continuing or being dropped.

## Community & support

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-db61a2?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/Yomag84)
[![Discord](https://img.shields.io/discord/1539426555451809812?logo=discord&logoColor=white&label=Discord)](https://discord.gg/fKWNtBHYHt)

- **Discord** — [join the server](https://discord.gg/fKWNtBHYHt) for help, feature discussion, and sharing routing/recording setups. Its structure was built via the Discord API — see `community/README.md` if you need to rebuild or extend it.
- **Sponsor** — if YomagAudio is useful to you, you can support its development via [GitHub Sponsors](https://github.com/sponsors/Yomag84).
- **Issues** — bug reports and feature requests belong on the [issue tracker](https://github.com/Yomag84/yomag-audio/issues).

## License

GPL-3.0.
