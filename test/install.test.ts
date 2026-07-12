import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { RunnerError } from "../src/errors.js";
import { installCodexCli } from "../src/install.js";

test("installs the bundled Codex lock in an isolated environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "vyben-install-test-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "npm"),
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.mkdirSync("node_modules/.bin", { recursive: true });
fs.writeFileSync("node_modules/.bin/codex", "#!/usr/bin/env node\\nconsole.log('codex-cli 0.144.1')\\n", { mode: 0o700 });
fs.writeFileSync("environment.json", JSON.stringify({
  openaiKey: process.env.OPENAI_API_KEY,
  npmToken: process.env.NPM_TOKEN,
  nodeOptions: process.env.NODE_OPTIONS,
  registry: process.env.npm_config_registry,
  home: process.env.HOME,
  temp: process.env.TMPDIR,
}));
`,
    { encoding: "utf8", mode: 0o700 },
  );

  let install: Awaited<ReturnType<typeof installCodexCli>> | undefined;
  try {
    install = await installCodexCli(root, {
      PATH: `${bin}:${process.env.PATH}`,
      OPENAI_API_KEY: "must-not-reach-installer",
      NPM_TOKEN: "must-not-reach-installer",
      NODE_OPTIONS: "--require=attacker.js",
      npm_config_registry: "https://attacker.example/",
    });
    const installRoot = resolve(install.binDir, "../..");
    const environment = JSON.parse(
      await readFile(join(installRoot, "environment.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(environment.openaiKey, undefined);
    assert.equal(environment.npmToken, undefined);
    assert.equal(environment.nodeOptions, undefined);
    assert.equal(environment.registry, "https://registry.npmjs.org/");
    assert.match(String(environment.home), /^.*vyben-codex-cli-/);
    assert.match(String(environment.temp), /^.*vyben-codex-cli-/);
    await install.cleanup();
    await assert.rejects(access(installRoot));
    install = undefined;
  } finally {
    await install?.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "kills installer descendants when bounded output is exceeded",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "vyben-install-kill-test-"));
    const bin = join(root, "bin");
    const pidFile = join(root, "descendant.pid");
    let descendantPid: number | undefined;
    try {
      await mkdir(bin);
      await writeFile(
        join(bin, "npm"),
        `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
process.stdout.write("x".repeat(300 * 1024));
setInterval(() => {}, 1000);
`,
        { encoding: "utf8", mode: 0o700 },
      );
      await assert.rejects(
        installCodexCli(root, { PATH: `${bin}:${process.env.PATH}` }),
        (error: unknown) =>
          error instanceof RunnerError && error.code === "codex_install_failed",
      );
      descendantPid = Number(await readFile(pidFile, "utf8"));
      assert.equal(await waitForProcessExit(descendantPid), true);
    } finally {
      if (descendantPid) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Expected when the install process group was terminated.
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
