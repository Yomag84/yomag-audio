; Hooked into the generated installer.nsi via bundle.windows.nsis.installerHooks
; (tauri.conf.json). Supported macros: NSIS_HOOK_PREINSTALL / POSTINSTALL /
; PREUNINSTALL / POSTUNINSTALL - see tauri-utils' NsisConfig::installer_hooks
; doc comment for the full list.
;
; The driver's .sys/.inf are bundled as ordinary resources (see
; tauri.conf.json's bundle.resources) and land in $INSTDIR\driver\ during
; the normal file-copy phase, same as any other resource - this hook's only
; job is the mandatory warning dialog afterward, since those files are
; inert (never installed, signed, or loaded) until the user deliberately
; walks through driver/YomagAudioDriver/README.md themselves.

!macro NSIS_HOOK_POSTINSTALL
  ; Silent/unattended installs (e.g. scripted deployment) shouldn't block
  ; on a dialog nobody's there to dismiss - the warning only matters for a
  ; human clicking through the installer interactively.
  IfSilent skip_driver_notice
  MessageBox MB_OK|MB_ICONEXCLAMATION \
    "YomagAudio has been installed.$\n$\n\
    Experimental virtual audio driver - read before using:$\n\
    The files for the optional kernel-mode virtual audio driver have been \
    placed in the $\"driver$\" folder inside the install directory, but \
    nothing has been installed, signed, or loaded automatically.$\n$\n\
    This driver has never been installed or loaded on a real machine. A \
    bug in kernel-mode code can affect audio-subsystem stability or crash \
    the machine - a materially higher risk than anything else in this app.$\n$\n\
    See driver\YomagAudioDriver\README.md in the install directory for the \
    full manual setup (get a test certificate and sign it, enable Windows \
    test-signing mode and reboot, then install via pnputil) - and test in \
    a VM before your daily-driver machine.$\n$\n\
    Every other YomagAudio feature - routing, mixing, applications, \
    recording, and editing - works without this driver."
  skip_driver_notice:
!macroend
