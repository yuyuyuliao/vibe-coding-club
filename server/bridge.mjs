import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.CLUB_BRIDGE_PORT || 4177);
const DATA_DIR = path.resolve("data");
const ROOMS_FILE = path.join(DATA_DIR, "rooms.json");
const agents = new Map();
const subscribers = new Map();

async function ensureData() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    await readFile(ROOMS_FILE, "utf8");
  } catch {
    await writeFile(ROOMS_FILE, "[]\n", "utf8");
  }
}

async function readRooms() {
  await ensureData();
  return JSON.parse(await readFile(ROOMS_FILE, "utf8"));
}

async function writeRooms(rooms) {
  await ensureData();
  await writeFile(ROOMS_FILE, `${JSON.stringify(rooms, null, 2)}\n`, "utf8");
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS"
  });
  res.end(JSON.stringify(body));
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function detectCodex() {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const located = spawnSync(locator, ["codex"], { encoding: "utf8" });
  const cliPath = located.status === 0 ? pickCodexExecutable(located.stdout.split(/\r?\n/).filter(Boolean)) : "";
  if (!cliPath) return { available: false, path: "", version: "" };

  const version = spawnSync(cliPath, ["--version"], { encoding: "utf8" });

  return {
    available: true,
    path: cliPath,
    version: version.status === 0 ? version.stdout.trim() || version.stderr.trim() : ""
  };
}

function pickCodexExecutable(candidates) {
  if (process.platform !== "win32") return candidates[0] || "";
  return (
    candidates.find((candidate) => candidate.toLowerCase().endsWith("codex.exe")) ||
    candidates.find((candidate) => candidate.toLowerCase().endsWith("codex.cmd")) ||
    candidates.find((candidate) => !candidate.toLowerCase().endsWith(".ps1")) ||
    ""
  );
}

function getCodexExecutable() {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const located = spawnSync(locator, ["codex"], { encoding: "utf8" });
  if (located.status !== 0) return "";
  return pickCodexExecutable(located.stdout.split(/\r?\n/).filter(Boolean));
}

function sendEvent(agentId, event) {
  const agent = agents.get(agentId);
  if (agent) {
    const stampedEvent = { ...event, at: new Date().toISOString() };
    agent.events.push(stampedEvent);
    agent.status = event.status || agent.status;
    agent.lastActivityAt = stampedEvent.at;
    if (event.type === "stdout" || event.type === "stderr") {
      agent.outputCount += 1;
    }
  }

  const clients = subscribers.get(agentId) || new Set();
  for (const res of clients) {
    res.write(`data: ${JSON.stringify(agent ? agent.events[agent.events.length - 1] : event)}\n\n`);
  }
}

function cleanTerminalText(text) {
  return String(text || "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, "")
    .replace(/\r/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function appendMessage(agent, role, content) {
  const cleaned = cleanTerminalText(content);
  if (!cleaned) return;
  const last = agent.messages[agent.messages.length - 1];
  if (last?.role === role && role === "assistant") {
    last.content = `${last.content}\n${cleaned}`.trim();
    last.at = new Date().toISOString();
    return;
  }
  agent.messages.push({
    id: randomUUID(),
    role,
    content: cleaned,
    at: new Date().toISOString()
  });
}

function spawnAgent({ room, prompt = "" }) {
  const id = randomUUID();
  const cwd = path.resolve(room.path);
  const tool = getCodexExecutable();
  if (!tool) {
    throw new Error("codex CLI was not found in PATH.");
  }

  const agent = {
    id,
    roomId: room.id,
    roomName: room.name,
    name: "Codex 小人",
    style: {
      hair: "#25323a",
      hairStyle: "short",
      body: "#2d8f7b",
      accessory: "none"
    },
    position: null,
    tool: "codex",
    cwd,
    pid: null,
    prompt,
    status: "starting",
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    outputCount: 0,
    events: [],
    messages: [],
    queue: [],
    runningTask: false
  };
  agents.set(id, agent);
  appendMessage(agent, "user", prompt);

  sendEvent(id, {
    type: "system",
    status: "running",
    text: `codex agent created in ${cwd}`
  });

  agent.heartbeat = setInterval(() => {
    if (agent.status !== "running" && agent.status !== "starting") return;
    sendEvent(id, {
      type: "heartbeat",
      status: "running",
      text: "Codex is still running."
    });
  }, 5000);

  runAgentTask(agent, prompt);
  return agent;
}

function runAgentTask(agent, input) {
  const prompt = String(input || "").trim();

  const tool = getCodexExecutable();
  if (!tool) {
    sendEvent(agent.id, {
      type: "error",
      status: "needs-human",
      text: "codex CLI was not found in PATH."
    });
    return;
  }

  if (agent.child && agent.pid) {
    try {
      killAgentProcess(agent);
      sendEvent(agent.id, {
        type: "system",
        status: "running",
        text: "Restarting this agent's Codex console."
      });
    } catch (error) {
      sendEvent(agent.id, {
        type: "error",
        status: "needs-human",
        text: `Failed to stop previous Codex console: ${error.message}`
      });
      return;
    }
  }

  agent.runningTask = true;
  agent.status = "running";
  const args = prompt ? [prompt] : [];
  const child = spawn(tool, args, {
    cwd: agent.cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    env: { ...process.env, FORCE_COLOR: "1" },
    shell: process.platform === "win32" && tool.toLowerCase().endsWith(".cmd")
  });
  agent.child = child;
  agent.pid = child.pid;
  sendEvent(agent.id, {
    type: "system",
    status: "running",
    text: `codex console started with PID ${child.pid}`
  });

  child.on("error", (error) => {
    agent.runningTask = false;
    agent.child = null;
    agent.pid = null;
    sendEvent(agent.id, { type: "error", status: "needs-human", text: error.message });
  });

  child.on("exit", (code) => {
    agent.runningTask = false;
    agent.child = null;
    agent.pid = null;
    sendEvent(agent.id, {
      type: "system",
      status: code === 0 ? "idle" : "needs-human",
      text: `codex console exited with code ${code}`
    });
  });
}

function getAgentSnapshot(agent) {
  return {
    id: agent.id,
    roomId: agent.roomId,
    roomName: agent.roomName,
    name: agent.name,
    style: agent.style,
    position: agent.position,
    tool: agent.tool,
    cwd: agent.cwd,
    pid: agent.pid,
    prompt: agent.prompt,
    status: agent.status,
    startedAt: agent.startedAt,
    lastActivityAt: agent.lastActivityAt,
    outputCount: agent.outputCount,
    events: agent.events,
    messages: agent.messages
  };
}

function killAgentProcess(agent) {
  if (!agent.child || !agent.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(agent.pid), "/T", "/F"], {
      encoding: "utf8"
    });
    return;
  }
  agent.child.kill("SIGTERM");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    json(res, 204, {});
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/api/cli/detect") {
      json(res, 200, { codex: detectCodex() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/rooms") {
      json(res, 200, { rooms: await readRooms() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/rooms") {
      const body = await parseBody(req);
      const projectPath = path.resolve(String(body.path || ""));
      const info = await stat(projectPath);
      if (!info.isDirectory()) {
        json(res, 400, { error: "Project path must be a directory" });
        return;
      }
      const rooms = await readRooms();
      const room = {
        id: randomUUID(),
        name: String(body.name || path.basename(projectPath) || "新房间"),
        path: projectPath,
        settings: {
          floor: "wood",
          wall: "morning"
        },
        createdAt: new Date().toISOString()
      };
      rooms.push(room);
      await writeRooms(rooms);
      json(res, 201, { room });
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/rooms/") && url.pathname.endsWith("/settings")) {
      const id = url.pathname.split("/")[3];
      const body = await parseBody(req);
      const rooms = await readRooms();
      const room = rooms.find((item) => item.id === id);
      if (!room) {
        json(res, 404, { error: "Room not found" });
        return;
      }

      room.name = String(body.name || room.name || "项目房间").slice(0, 40);
      room.settings = {
        floor: String(body.settings?.floor || room.settings?.floor || "wood"),
        wall: String(body.settings?.wall || room.settings?.wall || "morning")
      };
      await writeRooms(rooms);
      json(res, 200, { room });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agents") {
      json(res, 200, { agents: [...agents.values()].map(getAgentSnapshot) });
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/agents/")) {
      const id = url.pathname.split("/")[3];
      const agent = agents.get(id);
      if (!agent) {
        json(res, 404, { error: "Agent not found" });
        return;
      }

      clearInterval(agent.heartbeat);
      sendEvent(id, {
        type: "system",
        status: "done",
        text: "Agent was removed by user."
      });
      try {
        killAgentProcess(agent);
      } catch (error) {
        sendEvent(id, {
          type: "error",
          status: "needs-human",
          text: `Failed to kill agent process: ${error.message}`
        });
      }
      agents.delete(id);
      subscribers.get(id)?.forEach((client) => client.end());
      subscribers.delete(id);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agents") {
      const body = await parseBody(req);
      const rooms = await readRooms();
      const room = rooms.find((item) => item.id === body.roomId);
      if (!room) {
        json(res, 404, { error: "Room not found" });
        return;
      }
      const agent = spawnAgent({ room, prompt: body.prompt });
      json(res, 201, { agent: getAgentSnapshot(agent) });
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/agents/") && url.pathname.endsWith("/input")) {
      const id = url.pathname.split("/")[3];
      const agent = agents.get(id);
      if (!agent) {
        json(res, 404, { error: "Agent not found" });
        return;
      }
      const body = await parseBody(req);
      const input = String(body.input || "");
      appendMessage(agent, "user", input);
      runAgentTask(agent, input);
      sendEvent(id, { type: "human", text: input });
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/agents/") && url.pathname.endsWith("/prompt")) {
      const id = url.pathname.split("/")[3];
      const agent = agents.get(id);
      if (!agent) {
        json(res, 404, { error: "Agent not found" });
        return;
      }
      const body = await parseBody(req);
      agent.prompt = String(body.prompt || "");
      sendEvent(id, { type: "system", text: "Task instruction was updated." });
      json(res, 200, { agent: getAgentSnapshot(agent) });
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/agents/") && url.pathname.endsWith("/profile")) {
      const id = url.pathname.split("/")[3];
      const agent = agents.get(id);
      if (!agent) {
        json(res, 404, { error: "Agent not found" });
        return;
      }
      const body = await parseBody(req);
      agent.name = String(body.name || agent.name || "Codex 小人").slice(0, 24);
      agent.style = {
        hair: String(body.style?.hair || agent.style?.hair || "#25323a"),
        hairStyle: String(body.style?.hairStyle || agent.style?.hairStyle || "short"),
        body: String(body.style?.body || agent.style?.body || "#2d8f7b"),
        accessory: String(body.style?.accessory || agent.style?.accessory || "none")
      };
      if (body.position === null) {
        agent.position = null;
      } else if (body.position && Number.isFinite(body.position.x) && Number.isFinite(body.position.y)) {
        agent.position = {
          x: Math.max(0, Number(body.position.x)),
          y: Math.max(0, Number(body.position.y))
        };
      }
      sendEvent(id, { type: "system", text: "Agent profile was updated." });
      json(res, 200, { agent: getAgentSnapshot(agent) });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/agents/") && url.pathname.endsWith("/events")) {
      const id = url.pathname.split("/")[3];
      const agent = agents.get(id);
      if (!agent) {
        json(res, 404, { error: "Agent not found" });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*"
      });

      for (const event of agent.events) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }

      if (!subscribers.has(id)) subscribers.set(id, new Set());
      subscribers.get(id).add(res);
      req.on("close", () => subscribers.get(id)?.delete(res));
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

await ensureData();
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Vibe Coding Club bridge listening on http://127.0.0.1:${PORT}`);
});
