import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative by default so the build runs from any subpath when opened
  // directly. GitHub Pages project sites set BASE_PATH=/<repo>/ instead —
  // the web-ifc wasm is fetched through import.meta.env.BASE_URL, which needs
  // a real path rather than "./" once a worker resolves it.
  base: process.env.BASE_PATH || "./",
  build: {
    // web-ifc's wasm and the fragments worker are large by nature; the warning
    // adds nothing.
    chunkSizeWarningLimit: 4000,
  },
});
