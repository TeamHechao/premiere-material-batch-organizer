import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("Windows 助手验收必须在 Windows 运行，不能以跳过代替通过");
const root = fileURLToPath(new URL("../", import.meta.url));
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
const buildArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/build-material-helper.ps1"];
run("powershell.exe", buildArgs);
run("powershell.exe", [...buildArgs, "-TestHooks"]);
run(process.execPath, ["scripts/build.mjs"]);
if (existsSync(new URL("../dist-macos/", import.meta.url))) run(process.execPath, ["scripts/package-macos.mjs"]);
const tests = readdirSync(new URL("../tests/", import.meta.url)).filter(name => name.endsWith(".test.js")).sort();
// Native tests launch real Windows processes and flush to disk. Bound local
// concurrency so a many-core machine does not starve their response deadlines.
run(process.execPath, ["--test", "--test-concurrency=1", ...tests.map(name => "tests/" + name)], { ...process.env, MATERIAL_NATIVE_SMOKE: "1" });
run(process.execPath, ["scripts/verify-build.mjs"]);
