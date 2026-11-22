import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = new URL("./", import.meta.url);
const output = new URL("../core/assets/mcp_app_live.html", source);
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this build with npm run build:mcp-app.");

const temporary = await mkdtemp(join(tmpdir(), "gempt-mcp-app-"));
try {
  execFileSync(process.execPath, [
    npm, "install", "--prefix", temporary, "--no-save", "--no-package-lock", "--no-audit", "--no-fund",
    "@modelcontextprotocol/ext-apps@2.0.4", "esbuild@0.28.2", "zod@4.4.3",
  ], { stdio: "inherit", windowsHide: true });
  const require = createRequire(join(temporary, "package.json"));
  const script = execFileSync(process.execPath, [
    require.resolve("esbuild/bin/esbuild"), "app.js", "--bundle", "--format=iife", "--minify", "--target=es2022",
  ], {
    cwd: fileURLToPath(source),
    env: { ...process.env, NODE_PATH: join(temporary, "node_modules") },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const [template, styles] = await Promise.all([
    readFile(new URL("index.html", source), "utf8"),
    readFile(new URL("styles.css", source), "utf8"),
  ]);
  const html = template.replace("<!-- CSS -->", () => styles)
    .replace("/* SCRIPT */", () => script.replace(/<\/script/gi, "<\\/script"));
  await writeFile(output, html.replace(/\r\n/g, "\n"), "utf8");
  console.log(`GemPT Live · ${Buffer.byteLength(html)} bytes`);
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}
