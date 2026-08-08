import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        environment: "node"
    },
    resolve: {
        alias: {
            geoview: resolve(import.meta.dirname, "src/index.ts")
        }
    }
});
