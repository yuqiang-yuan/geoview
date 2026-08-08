import { describe, it, expect } from "vitest";
import { VERSION } from "geoview";

describe("geoview", () => {
    it("exports VERSION", () => {
        expect(VERSION).toBe("0.1.0");
    });
});
