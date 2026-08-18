import ReactDOM from "react-dom/client"
import App from "./App"
import "./index.css"

// Deliberately not wrapped in React.StrictMode: its dev-only double-invoke
// of effects is a well-documented trigger for orphaned Tauri event listeners
// (listen() returns a Promise; StrictMode's mount->unmount->remount cycle
// can unregister a listener before its registration round-trip even
// resolves), which is exactly what caused the repeated "[TAURI] Couldn't
// find callback id" spam. StrictMode has no effect on the production build
// either way, so this only removes noisy/misleading dev-time behavior.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />)
