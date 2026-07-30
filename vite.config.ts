import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `base: "./"` keeps the build deployable from a subpath (GitHub Pages
  // project sites live at /<repo>/).
  base: "./",
  build: {
    // web-ifc's wasm and the fragments worker are large by nature; the warning
    // adds nothing.
    chunkSizeWarningLimit: 4000,
  },
});
