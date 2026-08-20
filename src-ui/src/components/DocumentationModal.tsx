import { open } from "@tauri-apps/plugin-shell"
import { DISCORD_URL, DOCS_ISSUES_URL, DOCS_REPO_URL, DOCS_SPONSOR_URL } from "../lib/links"
import "./DocumentationModal.css"

interface DocumentationModalProps {
  onClose: () => void
}

const SECTIONS = [
  { id: "concepts", label: "Core Concepts" },
  { id: "routing", label: "Routing" },
  { id: "context-menus", label: "Right-Click Menus" },
  { id: "applications", label: "Applications" },
  { id: "network", label: "Network" },
  { id: "recording", label: "Recording & Editing" },
  { id: "settings", label: "Settings" },
  { id: "shortcuts", label: "Keyboard Shortcuts" },
  { id: "limitations", label: "Known Limitations" },
  { id: "help", label: "Getting Help" },
]

export function DocumentationModal({ onClose }: DocumentationModalProps) {
  return (
    <div className="documentation-overlay" onClick={onClose}>
      <div className="documentation-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="documentation-header">
          <h2>Documentation</h2>
          <button className="chip-remove" onClick={onClose} title="Close">
            ×
          </button>
        </div>

        <div className="documentation-body">
          <nav className="documentation-nav">
            {SECTIONS.map((s) => (
              <a key={s.id} href={`#doc-${s.id}`}>
                {s.label}
              </a>
            ))}
          </nav>

          <div className="documentation-content">
            <section id="doc-concepts">
              <h3>Core Concepts</h3>
              <p>
                YomagAudio routes audio through <strong>virtual devices</strong>. Each virtual
                device pulls audio in from any number of <strong>sources</strong> — a physical
                microphone, a running application, another virtual device's mix, or a peer's device
                published over the network — mixes those sources down onto its own{" "}
                <strong>output channels</strong>, and can forward ("monitor") those channels out to
                real speakers/headphones. Any device can also be <strong>recorded</strong>, capturing
                every source to its own track.
              </p>
              <p>
                Everything is wired together with a click-to-connect cable diagram: click a
                source's channel dot, then click an output channel's dot to connect them (click
                either dot again to cancel).
              </p>
            </section>

            <section id="doc-routing">
              <h3>Routing</h3>
              <ul>
                <li>
                  <strong>Create a device</strong> — use the channel-count buttons (2/8/16/32) at
                  the bottom of the device list to create a new virtual device starting at that many
                  output channels. Existing devices can change their channel count later from the
                  "Set Output Channels" buttons in the Output Channels column, or from either
                  right-click menu (see below).
                </li>
                <li>
                  <strong>Add a source</strong> — the "+" button above the Sources column opens a
                  browser listing every physical input device, every application currently playing
                  audio, and every other virtual device (for nesting one device's mix into another),
                  each with a live level meter so you can see what's actually making sound before
                  wiring it in.
                </li>
                <li>
                  <strong>Wire it up</strong> — click a source channel's dot, then an output
                  channel's dot, to connect them. A connected pair is drawn as a cable between the
                  two columns.
                </li>
                <li>
                  <strong>Monitors</strong> — toggle "Show Monitors" to reveal a third column for
                  forwarding output channels out to real devices. Each monitor has its own buffer
                  size, output delay, an optional WASAPI exclusive-mode switch (for devices whose
                  full channel count only shows up in exclusive mode), and a multi-band parametric
                  EQ, all under its "advanced settings" toggle.
                </li>
                <li>
                  <strong>Gain &amp; mute</strong> — every source card has a gain slider and a mute
                  button; muting still lets a device be recorded (see Recording below).
                </li>
              </ul>
            </section>

            <section id="doc-context-menus">
              <h3>Right-Click Menus</h3>
              <p>Every part of the Routing view supports a right-click context menu:</p>
              <ul>
                <li>
                  <strong>Empty canvas</strong> — Add Source, Set Output Channels, Add Monitor, and
                  Show/Hide Monitors, all in one menu without needing to find the right button.
                </li>
                <li>
                  <strong>A source card</strong> — Mute/Unmute or Remove that source.
                </li>
                <li>
                  <strong>An output channel card</strong> — Set Output Channels (2/8/16/32), applied
                  instantly.
                </li>
                <li>
                  <strong>A monitor card</strong> — toggle Exclusive Mode or Remove that monitor.
                </li>
                <li>
                  <strong>A device in the sidebar</strong> — the full menu (Rename, Enable/Disable,
                  Add Source, Set Output Channels, Add Monitor, Delete) for that device without
                  having to select it first — right-clicking selects it automatically.
                </li>
              </ul>
            </section>

            <section id="doc-applications">
              <h3>Applications</h3>
              <p>
                The Applications view lists every process currently producing audio, mirroring
                Windows' own Volume Mixer. Check a box to route that app's audio straight into a
                virtual device as a source, with inline gain/mute controls — no need to hunt for it
                in the routing graph.
              </p>
            </section>

            <section id="doc-network">
              <h3>Network</h3>
              <ul>
                <li>
                  <strong>Publish</strong> a device's mix so other YomagAudio instances on the LAN
                  can pull it in.
                </li>
                <li>
                  <strong>Discover peers</strong> automatically — no configuration needed; whatever
                  they're publishing shows up in the peer list.
                </li>
                <li>
                  <strong>Send Audio to Applications</strong> — route a device's mix into Zoom,
                  Teams, WhatsApp, Discord, or any other app as a microphone input. Windows has no
                  way to push audio directly into another process, so this creates a real Windows
                  audio endpoint (a virtual microphone) via the bundled kernel driver, wires the
                  selected device's mix onto it automatically, and tells you exactly what to
                  select in the target app's own audio/microphone settings — the same technique
                  tools like VB-Cable and Voicemeeter use. "Custom Virtual Devices" does the same
                  thing under a name of your choosing, for an app not in the quick list.
                </li>
                <li>
                  Both require Administrator privileges and the bundled kernel driver to already
                  be installed and signed on this machine (see Known Limitations) — every other
                  feature works without it.
                </li>
              </ul>
            </section>

            <section id="doc-recording">
              <h3>Recording &amp; Editing</h3>
              <p>
                From the Routing view's toolbar, with a device selected, hit <strong>Record</strong>{" "}
                to capture every one of its current sources to its own WAV file — a true multitrack
                take, not just a mixed-down file — then <strong>Stop</strong> to finish. You land in
                the Recordings view with that take ready to rename, delete, or open in the built-in
                editor.
              </p>
              <p>
                The editor is non-destructive: trim, split, move, and delete clips; per-track
                gain/pan/mute/solo; a per-track parametric EQ. Nothing here touches the original
                WAV files until you choose <strong>Export Mixdown</strong>, which renders a final
                stereo WAV using the same DSP path a live monitor uses.
              </p>
              <p>
                Need just one track instead of the whole mix? <strong>Save Track</strong> (on each
                track's row in the Main tab, or its channel strip in the Mixer tab) renders that
                one track's own edit list - clips, gain, pan, EQ - to its own WAV, ignoring
                mute/solo and Effect Return sends so you always get exactly that track, clean.
              </p>
              <p>
                A console strip above the Main/Mixer tabs adds:
              </p>
              <ul>
                <li>
                  <strong>Levels</strong> — live Input/Output VU meters and an Output fader for
                  preview monitoring only; it doesn't change the exported mixdown's level.
                </li>
                <li>
                  <strong>Tempo &amp; Sync</strong> — a BPM value and a metronome click during
                  preview playback. The click is a monitoring aid: it's never included in the
                  exported mixdown.
                </li>
                <li>
                  <strong>Effect Returns</strong> — shared send/return busses (Delay today) every
                  track can send a portion of its signal into, the classic "aux return" mixing
                  model. Add one, then in the Mixer tab each track strip grows a send knob for it.
                  Unlike the metronome, a return's processed sound <em>is</em> part of the mix and
                  does render into the exported mixdown.
                </li>
              </ul>
              <p>The Main tab's timeline itself:</p>
              <ul>
                <li>
                  <strong>Zoomable timeline</strong> — the Zoom slider in the transport bar controls
                  pixels-per-second; every track's waveform and the ruler above them stay pixel-
                  aligned and scroll together as one, however far you zoom in.
                </li>
                <li>
                  <strong>Manual "start from"</strong> — type an exact position (<code>m:ss</code> or
                  a plain number of seconds) into the transport bar's field and press Enter or{" "}
                  <strong>→</strong> to jump straight there, instead of clicking to find it.
                </li>
                <li>
                  <strong>Follow Playhead</strong> — on by default, this scrolls the timeline to
                  keep the playhead in view during playback. Toggle it off in the transport bar to
                  scrub or inspect elsewhere in the timeline while something plays without the view
                  jumping back.
                </li>
              </ul>
            </section>

            <section id="doc-settings">
              <h3>Settings</h3>
              <p>
                The gear button (or <kbd>Ctrl</kbd>+<kbd>,</kbd>) opens a read-only-ish overview:
                every physical device with its in-use status, the current engine sample rate and
                tick period, and every monitor's buffering settings in one table — handy for a
                quick health check without digging through each device individually.
              </p>
            </section>

            <section id="doc-shortcuts">
              <h3>Keyboard Shortcuts</h3>
              <table className="documentation-table">
                <tbody>
                  <tr>
                    <td>
                      <kbd>Ctrl</kbd>+<kbd>N</kbd>
                    </td>
                    <td>New virtual device</td>
                  </tr>
                  <tr>
                    <td>
                      <kbd>Ctrl</kbd>+<kbd>S</kbd>
                    </td>
                    <td>Save the current routing profile</td>
                  </tr>
                  <tr>
                    <td>
                      <kbd>Ctrl</kbd>+<kbd>O</kbd>
                    </td>
                    <td>Load the saved routing profile</td>
                  </tr>
                  <tr>
                    <td>
                      <kbd>Ctrl</kbd>+<kbd>R</kbd>
                    </td>
                    <td>Refresh the physical device list</td>
                  </tr>
                  <tr>
                    <td>
                      <kbd>Ctrl</kbd>+<kbd>,</kbd>
                    </td>
                    <td>Open Settings</td>
                  </tr>
                  <tr>
                    <td>
                      <kbd>Ctrl</kbd>+<kbd>Q</kbd>
                    </td>
                    <td>Quit YomagAudio</td>
                  </tr>
                </tbody>
              </table>
              <p className="documentation-hint">
                Closing the window hides it to the tray instead of quitting — routing keeps running
                in the background. Use the tray icon or <kbd>Ctrl</kbd>+<kbd>Q</kbd> to actually
                exit.
              </p>
            </section>

            <section id="doc-limitations">
              <h3>Known Limitations</h3>
              <ul>
                <li>
                  The kernel driver (behind Local Network Devices) compiles but ships uninstalled by
                  default — every other feature works without it.
                </li>
                <li>The network protocol is LAN-only: no NAT traversal, authentication, or encryption.</li>
                <li>Mixdown export is always 2-channel, even if individual tracks have more channels.</li>
                <li>The editor decodes an entire recording into memory rather than streaming it.</li>
                <li>
                  A recording only captures sources that existed on the device when Record was
                  pressed — one added mid-take gets no track.
                </li>
              </ul>
            </section>

            <section id="doc-help">
              <h3>Getting Help</h3>
              <p>
                Can't find what you're looking for here? The full README covers the data model, IPC
                command reference, and network protocol in more depth.
              </p>
              <div className="documentation-help-links">
                <button className="btn btn-secondary" onClick={() => open(DOCS_REPO_URL)}>
                  Full README on GitHub
                </button>
                <button className="btn btn-secondary" onClick={() => open(DOCS_ISSUES_URL)}>
                  Report an Issue
                </button>
                <button className="btn btn-secondary" onClick={() => open(DISCORD_URL)}>
                  💬 Join Discord
                </button>
                <button className="btn btn-secondary" onClick={() => open(DOCS_SPONSOR_URL)}>
                  ❤ Sponsor · Donate · Send a Gift
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
