import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "path";

export default defineConfig({
    plugins: [svelte()],
    root: resolve(__dirname, "dev"),
    resolve: {
        alias: {
            geoview: resolve(__dirname, "src/index.ts")
        }
    },
    server: {
        port: 5174,
        open: true
    },
    build: {
        lib: {
            entry: resolve(__dirname, "src/index.ts"),
            name: "geoview",
            fileName: "geoview",
            formats: ["es"]
        }
    }
});
