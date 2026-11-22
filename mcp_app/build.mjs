import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = new URL("./", import.meta.url);
const output = new URL("../core/assets/mcp_app_live.html", source);
const licensesOutput = new URL("../THIRD_PARTY_LICENSES.txt", source);
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this build with npm run build:mcp-app.");

async function writeThirdPartyLicenses(nodeModulesDir, meta) {
  const pkgNames = [...new Set(
    Object.values(meta.outputs || {})
      .flatMap((entry) => Object.keys(entry.inputs || {}))
      .filter((p) => p.includes("node_modules/"))
      .map((p) => p.split("node_modules/").at(-1).match(/^(@[^/]+\/[^/]+|[^/]+)/)?.[0])
      .filter(Boolean),
  )].sort();

  const lines = [
    "Third-Party Open Source Licenses",
    "=================================",
    "",
    "The prebuilt GemPT Live bundle (core/assets/mcp_app_live.html) bundles code from",
    "the following third-party open-source packages:",
    "",
  ];
  for (const name of pkgNames) {
    const dir = join(nodeModulesDir, name);
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    const entries = await readdir(dir);
    const licFile = entries.find((f) => /^licen[cs]e/i.test(f));
    const noticeFile = entries.find((f) => /^notice/i.test(f));
    lines.push("--------------------------------------------------------------------------------");
    lines.push(`Package: ${pkg.name}@${pkg.version}`);
    lines.push(`License: ${pkg.license || "See license text below"}`);
    if (pkg.homepage) lines.push(`Homepage: ${pkg.homepage}`);
    lines.push("");
    if (licFile) {
      lines.push((await readFile(join(dir, licFile), "utf8")).replace(/\r\n/g, "\n").trim());
    }
    if (noticeFile) {
      lines.push("");
      lines.push("NOTICE:");
      lines.push((await readFile(join(dir, noticeFile), "utf8")).replace(/\r\n/g, "\n").trim());
    }
    lines.push("");
  }
  await writeFile(licensesOutput, lines.join("\n"), "utf8");
  return pkgNames;
}

const temporary = await mkdtemp(join(tmpdir(), "gempt-mcp-app-"));
try {
  execFileSync(process.execPath, [
    npm, "install", "--prefix", temporary, "--no-save", "--no-package-lock", "--no-audit", "--no-fund",
    "@modelcontextprotocol/ext-apps@2.0.4", "esbuild@0.28.2", "zod@4.4.3",
  ], { stdio: "inherit", windowsHide: true });
  const require = createRequire(join(temporary, "package.json"));
  const metaFile = join(temporary, "meta.json");
  const script = execFileSync(process.execPath, [
    require.resolve("esbuild/bin/esbuild"), "app.js", "--bundle", "--format=iife", "--minify", "--target=es2022",
    `--metafile=${metaFile}`,
  ], {
    cwd: fileURLToPath(source),
    env: { ...process.env, NODE_PATH: join(temporary, "node_modules") },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const meta = JSON.parse(await readFile(metaFile, "utf8"));
  const pkgs = await writeThirdPartyLicenses(join(temporary, "node_modules"), meta);
  const [template, styles] = await Promise.all([
    readFile(new URL("index.html", source), "utf8"),
    readFile(new URL("styles.css", source), "utf8"),
  ]);
  const notice = `<!-- Third-party licenses bundled in this file: ${pkgs.join(", ")}. See THIRD_PARTY_LICENSES.txt. -->\n`;
  const html = notice + template.replace("<!-- CSS -->", () => styles)
    .replace("/* SCRIPT */", () => script.replace(/<\/script/gi, "<\\/script"));
  await writeFile(output, html.replace(/\r\n/g, "\n"), "utf8");
  console.log(`GemPT Live · ${Buffer.byteLength(html)} bytes · ${pkgs.length} third-party notices`);
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}
