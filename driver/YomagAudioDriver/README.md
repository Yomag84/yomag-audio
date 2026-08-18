# YomagAudioDriver

A minimal WDM/PortCls virtual audio driver: one KS filter exposing a
render pin ("Speaker") and a capture pin ("Microphone"), bridged internally
by a shared ring buffer so anything played to the render side is readable
from the capture side — a true virtual audio cable, running in kernel mode
so it works with *any* Windows audio app, not just ones YomagAudio can hook
into at the application level.

This is architecturally modeled on Microsoft's own **Sysvad** sample
("System Virtual Audio Device" — their reference driver for exactly this
kind of virtual device), scoped down to one render+capture pair instead of
Sysvad's full multi-endpoint complexity.

## Status: compiles clean, **not installed, not loaded, not tested**

`msbuild YomagAudioDriver.vcxproj /p:Configuration=Debug /p:Platform=x64`
succeeds and produces `x64\Debug\YomagAudioDriver.sys`. That confirms the
code is structurally sound C++ against the real WDK headers/libs. It does
**not** confirm the driver actually works at runtime, and it was
deliberately never installed or loaded on this machine — the agent that
wrote this driver cannot perceptually verify captured audio the way it can
run a test suite, and installing/loading a kernel driver is a materially
different risk class than anything else in this project: a bug here can
affect audio-subsystem stability or, in the worst case, crash the machine,
not just misbehave in a sandboxed process.

**Test this in a VM first**, not on your daily-driver machine, until you've
confirmed it's stable.

## Architecture

| File | Purpose |
|---|---|
| `public.h` | Miniport CLSIDs, pool tag, the one fixed PCM format (48kHz/16-bit/stereo) |
| `common.h` | Shared includes; `operator new`/`delete` overloads (WDM C++ has no CRT) |
| `unknown.cpp` | `CUnknown` implementation — `stdunk.h` (installed with the WDK) declares this class but its `.cpp` only ships in the separate WDK *samples* repo, not the headers/libs alone, so this is a from-scratch, contract-compatible implementation |
| `ringbuffer.h/.cpp` | The actual "cable" — spinlock-protected byte ring buffer bridging the render stream's DMA buffer to the capture stream's |
| `dmachannel.h/.cpp` | A minimal software-only `IDmaChannel` (plain kernel memory, no real bus-master hardware behind it — this device has none) |
| `mintopology.h/.cpp` | Topology filter: two bridge pins (`KSNODETYPE_SPEAKER`, `KSNODETYPE_MICROPHONE`), no interior nodes |
| `minwavecyclic.h/.cpp` | WaveCyclic filter: the actual render/capture streaming pins; `RequestService()` is where data moves between each DMA buffer and the shared ring buffer |
| `driver.cpp` | `DriverEntry` → `AddDevice` → `StartDevice`, wiring the topology + wave subdevices together |
| `YomagAudioDriver.inf` | Root-enumerated (non-PnP-detected) install descriptor — this is a virtual device with no real hardware to detect |

## Known scope limits (deliberate)

- **One fixed format only** (48000 Hz / 16-bit / stereo). Anything else is
  rejected in `SetFormat`/`NewStream` rather than attempting format
  conversion in the driver.
- **No jack description / advanced properties.** Real endpoint-surfacing
  polish (showing up exactly right in the Sound Control Panel with a nice
  icon, jack presence, etc.) often needs more property-handler
  infrastructure than this includes. If the device doesn't appear the way
  you expect, that's the first thing to look at.
- **`PcRegisterPhysicalConnection` pin-index wiring is best-effort.** It's
  informational (topology-graph metadata for tools/diagrams), not something
  the actual audio path depends on — the real routing is the ring buffer —
  but the exact connection semantics weren't independently verified.

## Building

Requires the WDK matching your installed SDK (confirmed present here:
`10.0.26100.0`) and Visual Studio's driver development workload.

```powershell
& "C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\amd64\MSBuild.exe" `
  YomagAudioDriver.vcxproj /p:Configuration=Debug /p:Platform=x64
```

Add `/p:SignMode=Off` if you hit a SignTool error about no digest algorithm
— that's the default post-build signing step failing because no signing
certificate is configured yet (expected; see below).

## What's left before this can actually run — all yours to do deliberately

1. **Get a test certificate and sign the driver.** Either:
   - `MakeCert`/`SignTool` to create a local test certificate and sign
     `YomagAudioDriver.sys`, or
   - Configure the project's Driver Signing properties in Visual Studio.
2. **Enable test signing mode**: `bcdedit /set testsigning on`, then
   **reboot**. This weakens Windows' driver-signature enforcement
   system-wide until you turn it back off — understand that before doing
   it, and don't leave it on a machine you don't control the security
   posture of.
3. **Install**, e.g. via `pnputil /add-driver YomagAudioDriver.inf
   /install`, or Device Manager → "Add legacy hardware" → let you pick
   from a list → Sound, video and game controllers.
4. **Test in a VM first.** If the driver has a bug that hangs or crashes
   the audio stack — or worse, the kernel — you want that to happen in a
   disposable VM, not your main machine.
5. If/when it loads: play something to the "YomagAudio Virtual Cable"
   speaker endpoint, record from its microphone endpoint, confirm you hear
   the same audio back. That's the actual functional test nothing short of
   running it can substitute for.

## Uninstalling

`pnputil /delete-driver <oem##.inf> /uninstall` (find the right `oem##.inf`
via `pnputil /enum-drivers`), then remove the device from Device Manager if
it's still listed, and `bcdedit /set testsigning off` + reboot once you're
done testing.
