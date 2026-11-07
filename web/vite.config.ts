import { defineConfig } from "vite";

// Relative asset paths, so the build works from any static host or sub-path.
export default defineConfig({
  base: "./",
  build: { target: "es2022" },
});
