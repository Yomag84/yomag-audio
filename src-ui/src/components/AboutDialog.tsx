import { open } from "@tauri-apps/plugin-shell"
import { DISCORD_URL, DOCS_ISSUES_URL, DOCS_REPO_URL, DOCS_SPONSOR_URL } from "../lib/links"
import "./AboutDialog.css"

interface AboutDialogProps {
  onClose: () => void
  onOpenDocumentation: () => void
}

export function AboutDialog({ onClose, onOpenDocumentation }: AboutDialogProps) {
  return (
    <div className="about-overlay" onClick={onClose}>
      <div className="about-dialog" onClick={(e) => e.stopPropagation()}>
        <button className="chip-remove about-close" onClick={onClose} title="Close">
          ×
        </button>

        <h2>YomagAudio</h2>
        <p className="about-tagline">A transit system for your audio</p>
        <p className="about-meta">Version 0.1.0 &middot; GPL-3.0 License</p>

        <p className="about-description">
          A free, open-source Windows audio router: route, mix, and monitor audio between hardware
          devices, running applications, other virtual devices, and other machines on the network —
          the same job as macOS's <em>Loopback</em> or <em>Voicemeeter</em>, built from scratch for a
          direct routing model and a modern UI.
        </p>

        <div className="about-links">
          <button className="btn btn-secondary" onClick={onOpenDocumentation}>
            📖 Documentation
          </button>
          <button className="btn btn-secondary" onClick={() => open(DOCS_REPO_URL)}>
            GitHub Repository
          </button>
          <button className="btn btn-secondary" onClick={() => open(DOCS_ISSUES_URL)}>
            Report an Issue
          </button>
          <button className="btn btn-secondary" onClick={() => open(DISCORD_URL)}>
            💬 Join Discord
          </button>
        </div>

        <div className="about-support">
          <h3>Support YomagAudio</h3>
          <p>
            YomagAudio is built and maintained for free, in the open. If it's useful to you, the
            best ways to help it keep going are a one-time gift, a recurring sponsorship, or simply
            spreading the word — every bit funds the time that goes into development, testing on
            real hardware, and support.
          </p>
          <button className="btn btn-primary about-sponsor-btn" onClick={() => open(DOCS_SPONSOR_URL)}>
            ❤ Sponsor · Donate · Send a Gift
          </button>
        </div>

        <p className="about-license-note">
          Free and open-source under the GPL-3.0 license — you're always welcome to use, study, and
          modify it without paying anything.
        </p>
      </div>
    </div>
  )
}
