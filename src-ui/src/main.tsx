import ReactDOM from "react-dom/client"
import App from "./App"
import "./index.css"

// WebView2's own default context menu (Back/Forward/Reload/Inspect
// Element/View Page Source…) has no place in a shipped desktop app - none
// of it does anything meaningful here, and it visually competes with this
// app's own right-click menus (see components/ContextMenu.tsx). Every
// element that opens an app-specific menu already calls
// `e.stopPropagation()` in its own "contextmenu" handler (see
// `useContextMenu`'s `open`), so this document-level fallback only ever
// fires - and only ever suppresses the native menu - where nothing
// app-specific was wired up to begin with.
document.addEventListener("contextmenu", (e) => e.preventDefault())

// Deliberately not wrapped in React.StrictMode: its dev-only double-invoke
// of effects is a well-documented trigger for orphaned Tauri event listeners
// (listen() returns a Promise; StrictMode's mount->unmount->remount cycle
// can unregister a listener before its registration round-trip even
// resolves), which is exactly what caused the repeated "[TAURI] Couldn't
// find callback id" spam. StrictMode has no effect on the production build
// either way, so this only removes noisy/misleading dev-time behavior.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />)
