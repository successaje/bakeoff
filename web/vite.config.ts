import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Relative asset paths, so the build works from any static host or sub-path.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { target: "es2022" },
});
