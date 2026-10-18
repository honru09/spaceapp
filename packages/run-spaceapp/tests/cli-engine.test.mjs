import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { composeCommand } from "../src/index.mjs";

function capture() {
  let value = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      value += chunk.toString();
      callback();
    }
  });
  return { stream, value: () => value };
}

function ttyStdin(...answers) {
  let index = 0;
  return {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    setEncoding() {},
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index >= answers.length) {
            return { done: true };
          }
          const answer = answers[index];
          index += 1;
          return { done: false, value: `${answer}\n` };
        },
        async return() {
          return { done: true };
        }
      };
    }
  };
}

// Mock execute that simulates a working podman installation.
function podmanExecute(responses = {}) {
  const calls = [];
  const execute = async (spec, io) => {
    calls.push(spec);
    const key = `${spec.command} ${spec.args.join(" ")}`;
    if (responses[key] !== undefined) {
      const response = responses[key];
      if (io?.stdout && typeof response === "string") {
        io.stdout.write(response);
      }
      return 0;
    }
    // Default: podman CLI available, compose available, daemon running.
    if (spec.command === "podman" && spec.args[0] === "--version") {
      if (io?.stdout) io.stdout.write("podman version 5.2.1\n");
      return 0;
    }
    if (spec.command === "podman" && spec.args[0] === "compose") {
      if (io?.stdout) io.stdout.write("podman-compose version 1.0.6\n");
      return 0;
    }
    if (spec.command === "podman" && spec.args[0] === "info") {
      if (io?.stdout) {
        io.stdout.write(JSON.stringify({
          version: { Version: "5.2.1" },
          host: {
            arch: "amd64",
            cpus: 8,
            memTotal: 16000000000,
            security: { rootless: true },
            cgroupVersion: "v2"
          },
          store: { graphRoot: "/home/user/.local/share/containers/storage" }
        }));
      }
      return 0;
    }
    return 0;
  };
  return { execute, calls };
}

test("composeCommand builds podman compose commands when engine is podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-test-"));
  const spec = composeCommand("up", root, { profile: "small", engine: "podman" });
  assert.equal(spec.command, "podman");
  assert.deepEqual(spec.args.slice(0, 2), ["compose", "--project-name"]);
});

test("composeCommand defaults to docker compose when engine is not set", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-test-"));
  const spec = composeCommand("up", root, { profile: "small" });
  assert.equal(spec.command, "docker");
  assert.deepEqual(spec.args.slice(0, 2), ["compose", "--project-name"]);
});

test("--engine podman with --access host-root is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-test-"));
  const stdout = capture();
  const stderr = capture();
  const { execute } = podmanExecute();
  await assert.rejects(
    run(["install", "--engine", "podman", "--access", "host-root", "--profile", "small"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdin: ttyStdin(),
      stdout: stdout.stream,
      stderr: stderr.stream,
      execute,
      inspectResources: async () => ({ cpuCount: 4, totalMemoryBytes: 8 * 1024 ** 3, freeDiskBytes: 15 * 1024 ** 3 }),
      request: async () => ({ ok: true, json: async () => ({ ok: true }) }),
      sleep: async () => {}
    }),
    /host-root access is not supported with the Podman engine/i
  );
});

test("--engine with invalid value is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-test-"));
  const stdout = capture();
  const stderr = capture();
  const { execute } = podmanExecute();
  await assert.rejects(
    run(["install", "--engine", "nerdctl", "--profile", "small"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdin: ttyStdin(),
      stdout: stdout.stream,
      stderr: stderr.stream,
      execute,
      inspectResources: async () => ({ cpuCount: 4, totalMemoryBytes: 8 * 1024 ** 3, freeDiskBytes: 15 * 1024 ** 3 }),
      request: async () => ({ ok: true, json: async () => ({ ok: true }) }),
      sleep: async () => {}
    }),
    /--engine docker\|podman/
  );
});

test("podman and podman-compose are in the trusted command allowlist", async () => {
  // The allowlist is enforced by executeCommand; verify via a direct dispatch test.
  // We test that composeCommand produces podman specs (covered above) and that
  // the CLI module loads with both commands trusted (no throw on import).
  const { executeCommand } = await import("../src/cli.mjs");
  // executeCommand rejects untrusted commands synchronously via promise rejection.
  await assert.rejects(
    executeCommand({ command: "evil-binary", args: [] }),
    /untrusted command/i
  );
  // podman/podman-compose must NOT be rejected as untrusted (they will fail with
  // ENOENT/127 at spawn time, not with the untrusted-command error).
  const podmanResult = await executeCommand({ command: "podman", args: ["--version"] }).catch((e) => e);
  assert.ok(
    !(podmanResult instanceof Error) || !/untrusted command/i.test(podmanResult.message),
    "podman should be a trusted command"
  );
});
