import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: {
    // tsup 8 injects baseUrl while bundling declarations; TypeScript 6 deprecates it.
    compilerOptions: { ignoreDeprecations: "6.0" },
  },
  sourcemap: true,
  clean: true,
  target: "es2022",
  splitting: false,
  external: ["pg", "@langchain/core"],
});
