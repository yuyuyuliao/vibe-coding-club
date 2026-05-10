import { spawn } from "node:child_process";
import path from "node:path";

const viteCli = path.resolve("node_modules", "vite", "bin", "vite.js");

const processes = [
  spawn(process.execPath, ["server/bridge.mjs"], {
    stdio: "inherit"
  }),
  spawn(process.execPath, [viteCli, "--host", "127.0.0.1"], {
    stdio: "inherit",
    env: { ...process.env, VITE_BRIDGE_URL: "http://127.0.0.1:4177" }
  })
];

const shutdown = () => {
  for (const child of processes) {
    if (!child.killed) child.kill();
  }
};

for (const child of processes) {
  child.on("exit", (code) => {
    if (code && code !== 0) {
      shutdown();
      process.exit(code);
    }
  });
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
