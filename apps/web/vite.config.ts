import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" lets the built board be served from any path (GitHub Pages, a sub-folder, a file host).
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { port: 5173 },
});
