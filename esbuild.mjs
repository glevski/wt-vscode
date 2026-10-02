// Bundles the extension into dist/extension.js. With --test it instead
// bundles each src/*.test.ts into out/test/ for `node --test`.
import { build, context } from "esbuild";
import { readdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
const test = process.argv.includes("--test");

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  logLevel: "info",
};

if (test) {
  rmSync("out/test", { recursive: true, force: true });
  await build({
    ...common,
    entryPoints: readdirSync("src")
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => `src/${f}`),
    outdir: "out/test",
    sourcemap: "inline",
  });
} else {
  const options = {
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    external: ["vscode"],
    minify: !watch,
    sourcemap: watch,
  };
  if (watch) {
    await (await context(options)).watch();
  } else {
    await build(options);
  }
}
