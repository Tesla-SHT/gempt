import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = new URL("./", import.meta.url);
const httpOutput = new URL("../core/assets/http-ui/", source);
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
    "The prebuilt GemPT bundle (core/assets/http-ui/app.js) bundles code from",
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
      lines.push((await readFile(join(dir, licFile), "utf8")).replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim());
    }
    if (noticeFile) {
      lines.push("");
      lines.push("NOTICE:");
      lines.push((await readFile(join(dir, noticeFile), "utf8")).replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim());
    }
    lines.push("");
  }
  const nextText = lines.join("\n");
  let existingText = null;
  try { existingText = await readFile(licensesOutput, "utf8"); } catch {}
  if (existingText !== nextText) {
    await writeFile(licensesOutput, nextText, "utf8");
  }
  return pkgNames;
}

const temporary = await mkdtemp(join(tmpdir(), "gempt-http-ui-"));
let esbuild;
try {
  execFileSync(process.execPath, [
    npm, "install", "--prefix", temporary, "--no-save", "--no-package-lock", "--no-audit", "--no-fund",
    "esbuild@0.28.2", "marked@18.2.0", "entities@7.0.1",
  ], { stdio: "inherit", windowsHide: true });
  const require = createRequire(join(temporary, "package.json"));
  const nodeModules = join(temporary, "node_modules");
  esbuild = require("esbuild");
  const consoleSource = new URL('../magpie_plugin/ui/', source);
  const [template, styles, swarmCss, hiveCss, consoleHtml, consoleCss] = await Promise.all([
    readFile(new URL("index.html", source), "utf8"),
    readFile(new URL("styles.css", source), "utf8"),
    readFile(new URL("swarm.css", source), "utf8"),
    readFile(new URL("hive.css", source), "utf8"),
    readFile(new URL("index.html", consoleSource), "utf8"),
    readFile(new URL("styles.css", consoleSource), "utf8"),
  ]);
  const consoleMarkup = consoleHtml.match(/<!-- CONSOLE START -->([\s\S]*?)<!-- CONSOLE END -->/)?.[1].trim();
  if (!consoleMarkup?.startsWith('<div id="view-console" class="console-host">')) {
    throw new Error("Shared Console markup is missing its root.");
  }
  const renderTemplate = (template) => template.replace("<!-- CONSOLE MARKUP -->",
    () => consoleMarkup.replace('class="console-host"', 'class="console-host" hidden'));
  const http = await esbuild.build({
    absWorkingDir: fileURLToPath(source), nodePaths: [nodeModules], entryPoints: ["http-entry.js"],
    bundle: true, format: "iife", minify: true, charset: "utf8", target: "es2022", metafile: true, write: false,
  });
  if (Object.keys(http.metafile.inputs).some((path) => /(?:@modelcontextprotocol|@cfworker|[/\\]zod)[/\\]/.test(path))) {
    throw new Error("MCP dependencies leaked into the HTTP UI.");
  }
  const pkgs = await writeThirdPartyLicenses(nodeModules, http.metafile);
  const splitHtml = renderTemplate(template)
    .replace(/[ \t]*<meta\b(?=[^>]*\bhttp-equiv\s*=\s*(?:"content-security-policy"|'content-security-policy'|content-security-policy(?=[\s/>])))[^>]*>\r?\n?/gi, "")
    .replace(/<style>[\s\S]*?<\/style>/, '<link rel="stylesheet" href="./styles.css">')
    .replace('<script>/* SCRIPT */</script>', '<script defer src="./app.js"></script>');
  const splitCss = [styles, swarmCss, hiveCss, consoleCss].join("\n");
  await mkdir(httpOutput, { recursive: true });
  await Promise.all([
    writeFile(new URL("index.html", httpOutput), splitHtml.replace(/\r\n/g, "\n"), "utf8"),
    writeFile(new URL("styles.css", httpOutput), splitCss.replace(/\r\n/g, "\n"), "utf8"),
    writeFile(new URL("app.js", httpOutput), http.outputFiles[0].text, "utf8"),
  ]);
  console.log(`GemPT HTTP UI · ${Buffer.byteLength(splitHtml) + Buffer.byteLength(splitCss) + http.outputFiles[0].contents.length} bytes across HTML, CSS and JS · ${pkgs.length} third-party notices`);
} finally {
  esbuild?.stop();
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}
