import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  root: "src-ui",
  plugins: [react()],

  // Vite options tailored for Tauri to prevent too much magic happening
  // behind the scenes. Clear consignments this way ensures there's no
  // other Vite config naming in `other` files which might collide.
  clearScreen: false,

  // Tauri expects a fixed port, fail if that port is not available.
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // Using a polling interval of 30ms
      // npx tauri dev SHOULD call chokidar's changeDetected.
      // CONFIG EYES EARS
      interval: 30,
    },
  },

  // To make use of `TAURI_DEBUG` and other env variables
  // https://tauri.app/blog/2024/01/09/tauri-with-next-js/#configure-vite
  envPrefix: ["VITE_", "TAURI_"],

  build: {
    // Tauri uses `cargo build` when `bundle` is enabled for updater,
    // this means frontendDist or whatever it's called needs to be this directory
    // after build. `cargo build` copies files to `../target` or something
    outDir: "../src-tauri/ui",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      // splashscreen.html is a second, genuinely static entry (no React)
      // so the splash window in main.rs's setup() can paint instantly
      // instead of waiting on the main app's JS bundle.
      input: {
        main: "src-ui/index.html",
        splashscreen: "src-ui/splashscreen.html",
      },
    },
  },
}))
