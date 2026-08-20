# YomagAudioDriver

A minimal ACX (Audio Class eXtension) virtual audio driver: two circuits,
"Speaker" (render) and "Microphone" (capture), bridged internally by a
shared ring buffer so anything played to the render side is readable from
the capture side — a true virtual audio cable, running in kernel mode so it
works with *any* Windows audio app, not just ones YomagAudio can hook into
at the application level.

ACX is Microsoft's current-generation audio driver framework (available
since Windows 10 version 2004), built on KMDF rather than raw WDM/PortCls —
it is still a **kernel-mode** framework (not UMDF/user-mode; Microsoft's own
docs are explicit that ACX stays in kernel mode specifically to avoid the
latency of task-switching between user and kernel mode while streaming), but
it replaces PortCls's COM-flavored miniport/subdevice/IServiceSink model
with a more direct circuit/pin/packet API. This driver previously used raw
WDM/PortCls (modeled on Microsoft's **Sysvad** sample); it has since been
ported to ACX, scoped down to one render+capture pair.

## Status: compiles, links, and test-signs clean — **not installed, not loaded, not tested**

Both `Debug|x64` and `Release|x64` build end-to-end — compile, link, and the
post-build TestSign step (against the local `WDKTestCert` already registered
on this machine) — producing a signed `YomagAudioDriver.sys` +
`YomagAudioDriver.inf` + `.cat`. That confirms the code is structurally
sound C++ against the real ACX/KMDF headers and libraries, correctly wired
per Microsoft's own ACX sample driver conventions, and packaged the way a
real install expects. It does **not** confirm the driver actually works at
runtime, and it was deliberately never installed or loaded on this machine —
the agent that wrote this driver cannot perceptually verify captured audio
the way it can run a test suite, and installing/loading a kernel driver is a
materially different risk class than anything else in this project: a bug
here can affect audio-subsystem stability or, in the worst case, crash the
machine, not just misbehave in a sandboxed process.

**Test this in a VM first**, not on your daily-driver machine, until you've
confirmed it's stable.

> The main app's NSIS installer bundles this driver's `.sys`/`.inf` (a
> Release build of it) so they're on disk after a normal install — see the
> root `README.md`'s "Build an installer" section. That's purely a file
> copy with a mandatory warning dialog; none of the "not installed, not
> loaded, not tested" status above changes because of it. Everything in
> "What's left before this can actually run" further down is still a
> deliberate step you take yourself.

## Architecture

| File | Purpose |
|---|---|
| `public.h` | Component-ID GUIDs, pool tag, the one fixed PCM format (48kHz/16-bit/32-channel) as a `KSDATAFORMAT_WAVEFORMATEXTENSIBLE` literal |
| `common.h` | Shared includes (`ntddk.h`, `wdf.h`, `acx.h`, `ks.h`/`ksmedia.h` plus the `windef.h`/`mmsystem.h`/`ntintsafe.h` those need in kernel mode); `operator new`/`delete` overloads (no CRT in kernel mode) |
| `unknown.cpp` | The `operator new`/`delete` implementations. ACX has no COM/`CUnknown` model the way PortCls did, so unlike the old driver this is just placement-new/delete over `ExAllocatePool2`, nothing more |
| `context.h` | ACX/WDF object-context structs (`WDF_DECLARE_CONTEXT_TYPE_WITH_NAME`) for the device, each circuit, each stream, and the notification timer |
| `ringbuffer.h/.cpp` | The actual "cable" — spinlock-protected byte ring buffer bridging the render circuit's stream to the capture circuit's. Unchanged from the WDM version; this class is framework-agnostic |
| `streamengine.h/.cpp` | `CYomagStreamEngine` base + render/capture subclasses. ACX's RT streaming model is double-buffered packets, not one big cyclic DMA buffer: a self-rescheduling one-shot `WDFTIMER` fires once per packet duration (`ProcessPacket()`) and moves that packet's audio between its buffer and the shared ring buffer — the same role `RequestService()` played in the old WaveCyclic miniport |
| `rendercircuit.h/.cpp` | Builds the "Speaker" circuit: host pin (what WASAPI opens) + bridge pin (`KSNODETYPE_SPEAKER`, tells AudioEndpointBuilder this is a render endpoint) |
| `capturecircuit.h/.cpp` | Builds the "Microphone" circuit: mirrors the render circuit with `KSNODETYPE_MICROPHONE` |
| `driver.h/driver.cpp` | `DriverEntry` → `AcxDriverInitialize`; `EvtDeviceAdd` creates the device, the shared ring buffer, and both circuits; `EvtDevicePrepareHardware`/`EvtDeviceReleaseHardware` attach/detach the circuits via `AcxDeviceAddCircuit`/`AcxDeviceRemoveCircuit` |
| `YomagAudioDriver.inf` | Root-enumerated (non-PnP-detected) install descriptor with a `KmdfService` section and per-endpoint (`Speaker`/`Microphone`) device-interface registrations — this is a virtual device with no real hardware to detect |

Unlike PortCls, ACX circuits are self-contained: there's no separate
Topology filter to cross-wire via `PcRegisterPhysicalConnection` — each
circuit's bridge pin category (`KSNODETYPE_SPEAKER`/`KSNODETYPE_MICROPHONE`)
alone is enough for AudioEndpointBuilder to recognize it as an endpoint.

## Known scope limits (deliberate)

- **One fixed format only** (48000 Hz / 16-bit / 32-channel, both circuits).
  Anything else is rejected — a client must open the device with exactly 32
  channels, not fewer. Changing `YOMAG_CHANNELS` in `public.h` is the single
  point of control for this; the format literal and every buffer-size
  calculation derive from it.
- **Non-paged pool cost scales with the channel count.** At 32 channels the
  shared cable ring buffer (`YOMAG_CABLE_BUFFER_BYTES`) alone is sized for 1
  second of 48kHz/16-bit/32-channel audio (~3MB non-paged), plus each
  circuit's RT packet allocations on top — worth knowing before creating
  many virtual devices at once, since non-paged pool is a shared, finite
  system resource.
- **No jack description / advanced properties.** Real endpoint-surfacing
  polish (showing up exactly right in the Sound Control Panel with a nice
  icon, jack presence, etc.) often needs more property-handler
  infrastructure than this includes. If the device doesn't appear the way
  you expect, that's the first thing to look at.

## Building

Requires the WDK matching your installed SDK (confirmed present here:
`10.0.26100.0`, ACX 1.1 headers/`acxstub.lib`, KMDF 1.31) and Visual
Studio's driver development workload.

```powershell
& "C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\amd64\MSBuild.exe" `
  YomagAudioDriver.vcxproj /p:Configuration=Debug /p:Platform=x64
```

The project already has a `DriverSign` item with `FileDigestAlgorithm=SHA256`
set (newer `signtool.exe` versions reject an omitted `/fd` outright), and
will test-sign against whatever WDK test certificate is already registered
in your local certificate store — on this machine that's `WDKTestCert
<username>`, created automatically the first time a driver project here was
built. Add `/p:SignMode=Off` if you don't have a test certificate yet and
just want to confirm the code compiles.

## What's left before this can actually run — all yours to do deliberately

1. **Enable test signing mode**: `bcdedit /set testsigning on`, then
   **reboot**. This weakens Windows' driver-signature enforcement
   system-wide until you turn it back off — understand that before doing
   it, and don't leave it on a machine you don't control the security
   posture of.
2. **Install**, e.g. via `pnputil /add-driver YomagAudioDriver.inf
   /install`, or Device Manager → "Add legacy hardware" → let you pick
   from a list → Sound, video and game controllers.
3. **Test in a VM first.** If the driver has a bug that hangs or crashes
   the audio stack — or worse, the kernel — you want that to happen in a
   disposable VM, not your main machine.
4. If/when it loads: play something to the "YomagAudio Virtual Cable"
   speaker endpoint, record from its microphone endpoint, confirm you hear
   the same audio back. That's the actual functional test nothing short of
   running it can substitute for.

## Uninstalling

`pnputil /delete-driver <oem##.inf> /uninstall` (find the right `oem##.inf`
via `pnputil /enum-drivers`), then remove the device from Device Manager if
it's still listed, and `bcdedit /set testsigning off` + reboot once you're
done testing.
