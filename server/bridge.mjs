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
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
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

function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "output_text" || part?.type === "text") return part.text || "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractAssistantTextFromCodexEvent(event) {
  const candidates = [event.item, event.message, event.payload, event];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.role === "assistant") {
      const text = extractTextContent(candidate.content || candidate.text || candidate.message);
      if (text) return text;
    }
    if (candidate.type === "assistant_message") {
      const text = extractTextContent(candidate.content || candidate.text || candidate.message);
      if (text) return text;
    }
    if (candidate.type === "agent_message") {
      const text = extractTextContent(candidate.content || candidate.text || candidate.message);
      if (text) return text;
    }
  }
  return "";
}

function textFromUnknown(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromUnknown).filter(Boolean).join("\n");
  if (typeof value === "object") {
    return [value.message, value.text, value.reason, value.command, value.description, value.prompt, value.question, value.content]
      .map(textFromUnknown)
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractApprovalPromptFromCodexEvent(event) {
  const candidates = [event.item, event.message, event.payload, event].filter(Boolean);
  for (const candidate of candidates) {
    const type = String(candidate.type || event.type || "").toLowerCase();
    const name = String(candidate.name || "").toLowerCase();
    if (candidate.role === "assistant" || type === "assistant_message" || type === "agent_message") continue;
    const text = cleanTerminalText(textFromUnknown(candidate));
    const searchable = `${type}\n${name}\n${text}`.toLowerCase();
    const hasApprovalType = /(approval|confirm|permission)/.test(`${type} ${name}`);
    const asksYesNo = /(yes\/no|\by\/n\b|do you want|allow|approve|confirm|是否|确认|允许|批准|同意|拒绝)/i.test(searchable);
    if ((hasApprovalType || asksYesNo) && text) return text;
  }
  return "";
}

function describeCodexEvent(event) {
  const type = String(event?.type || "event");
  const item = event?.item || event?.message || event?.payload || {};
  const itemType = item?.type ? ` / ${item.type}` : "";
  const status = item?.status ? ` / ${item.status}` : "";
  const text = cleanTerminalText(textFromUnknown(item) || textFromUnknown(event));
  const head = `Codex 事件：${type}${itemType}${status}`;
  if (!text) return head;
  return `${head}\n${text}`.slice(0, 4000);
}

function createJsonLineReader(onLine) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) onLine(line);
    }
  };
}

function createCodexInvocation(tool, cwd, prompt) {
  const codexArgs = String(prompt || "").trim() ? [prompt] : [];
  if (process.platform === "darwin") {
    return {
      command: "script",
      args: ["-q", "/dev/null", tool, "--no-alt-screen", "-C", cwd, ...codexArgs],
      silentConsole: true,
      jsonOutput: false,
      persistent: true
    };
  }

  return {
    command: tool,
    args: codexArgs,
    silentConsole: false,
    jsonOutput: false,
    persistent: false
  };
}

function sendInputToAgentProcess(agent, input) {
  const text = String(input || "").trim();
  if (!text) return;
  if (!agent.child?.stdin || agent.child.stdin.destroyed) {
    throw new Error("Codex 进程当前无法接收新任务。");
  }
  agent.child.stdin.write(`${text}\n`);
}

function spawnAgent({ room, prompt = "" }) {
  const id = randomUUID();
  const cwd = path.resolve(room.path);
  const tool = getCodexExecutable();
  if (!tool) {
    throw new Error("未在 PATH 中找到 codex CLI。");
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
    pendingApproval: null,
    queue: [],
    runningTask: false
  };
  agents.set(id, agent);
  appendMessage(agent, "user", prompt);

  sendEvent(id, {
    type: "system",
    status: "running",
    text: `已在 ${cwd} 创建 Codex 小人。`
  });

  agent.heartbeat = setInterval(() => {
    if (agent.status !== "running" && agent.status !== "starting") return;
    sendEvent(id, {
      type: "heartbeat",
      status: "running",
      text: "Codex 仍在运行。"
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
      text: "未在 PATH 中找到 codex CLI。"
    });
    return;
  }

  if (agent.child && agent.pid && agent.persistent) {
    try {
      sendInputToAgentProcess(agent, prompt);
      sendEvent(agent.id, {
        type: "system",
        status: "running",
        text: "已发送到现有 Codex 进程。"
      });
    } catch (error) {
      sendEvent(agent.id, {
        type: "error",
        status: "needs-human",
        text: `发送任务失败：${error.message}`
      });
    }
    return;
  }

  if (agent.child && agent.pid) {
    try {
      killAgentProcess(agent);
      sendEvent(agent.id, {
        type: "system",
        status: "running",
        text: "正在重启这个小人的 Codex 进程。"
      });
    } catch (error) {
      sendEvent(agent.id, {
        type: "error",
        status: "needs-human",
        text: `停止上一个 Codex 进程失败：${error.message}`
      });
      return;
    }
  }

  agent.runningTask = true;
  agent.status = "running";
  agent.pendingApproval = null;
  const invocation = createCodexInvocation(tool, agent.cwd, prompt);
  agent.persistent = invocation.persistent;
  const child = spawn(invocation.command, invocation.args, {
    cwd: agent.cwd,
    detached: !invocation.silentConsole,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: false,
    env: { ...process.env, FORCE_COLOR: "1" },
    shell: process.platform === "win32" && invocation.command === tool && tool.toLowerCase().endsWith(".cmd")
  });
  agent.child = child;
  agent.pid = child.pid;
  sendEvent(agent.id, {
    type: "system",
    status: "running",
    text: invocation.silentConsole
      ? `Codex 已在后台静默启动，PID：${child.pid}`
      : `Codex 控制台已启动，PID：${child.pid}`
  });
  if (invocation.jsonOutput) child.stdin?.end();

  const onJsonLine = createJsonLineReader((line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const approvalPrompt = extractApprovalPromptFromCodexEvent(event);
    if (approvalPrompt && !agent.pendingApproval) {
      agent.pendingApproval = {
        id: randomUUID(),
        text: approvalPrompt,
        createdAt: new Date().toISOString()
      };
      sendEvent(agent.id, {
        type: "approval",
        status: "needs-human",
        text: approvalPrompt,
        approval: agent.pendingApproval
      });
      return;
    }
    const text = cleanTerminalText(extractAssistantTextFromCodexEvent(event));
    if (text) {
      appendMessage(agent, "assistant", text);
      sendEvent(agent.id, { type: "stdout", status: "running", text });
      return;
    }
    sendEvent(agent.id, {
      type: "detail",
      status: "running",
      text: describeCodexEvent(event)
    });
  });

  child.stdout?.on("data", (chunk) => {
    if (invocation.jsonOutput) {
      onJsonLine(chunk.toString("utf8"));
      return;
    }
    const text = cleanTerminalText(chunk.toString("utf8"));
    if (!text) return;
    if (invocation.persistent) {
      sendEvent(agent.id, { type: "detail", status: "running", text });
      return;
    }
    appendMessage(agent, "assistant", text);
    sendEvent(agent.id, { type: "stdout", status: "running", text });
  });

  child.stderr?.on("data", (chunk) => {
    if (invocation.jsonOutput) return;
    const text = cleanTerminalText(chunk.toString("utf8"));
    if (!text) return;
    sendEvent(agent.id, { type: "stderr", status: "running", text });
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
    if (code === 0) agent.pendingApproval = null;
    sendEvent(agent.id, {
      type: "system",
      status: code === 0 ? "idle" : "needs-human",
      text: `Codex 进程已退出，退出码：${code}`
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
    messages: agent.messages,
    pendingApproval: agent.pendingApproval
  };
}

function answerAgentApproval(agent, decision) {
  const normalized = String(decision || "").toLowerCase();
  if (normalized === "dismiss") {
    agent.pendingApproval = null;
    sendEvent(agent.id, { type: "approval-resolved", status: "needs-human", text: "已暂时关闭确认提醒。" });
    return;
  }

  if (normalized !== "yes" && normalized !== "no") {
    throw new Error("确认选择无效。");
  }
  if (!agent.child?.stdin || agent.child.stdin.destroyed) {
    throw new Error("当前静默模式下无法向 Codex 写入确认，请查看详细 CLI 后手动处理。");
  }

  agent.child.stdin.write(normalized === "yes" ? "y\n" : "n\n");
  agent.pendingApproval = null;
  sendEvent(agent.id, {
    type: "approval-resolved",
    status: "running",
    text: normalized === "yes" ? "已向 Codex 发送允许。" : "已向 Codex 发送拒绝。"
  });
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
        json(res, 400, { error: "项目路径必须是一个目录。" });
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
        json(res, 404, { error: "未找到房间。" });
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
        json(res, 404, { error: "未找到小人。" });
        return;
      }

      clearInterval(agent.heartbeat);
      sendEvent(id, {
        type: "system",
        status: "done",
        text: "小人已被移除。"
      });
      try {
        killAgentProcess(agent);
      } catch (error) {
        sendEvent(id, {
          type: "error",
          status: "needs-human",
          text: `终止小人进程失败：${error.message}`
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
        json(res, 404, { error: "未找到房间。" });
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
        json(res, 404, { error: "未找到小人。" });
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

    if (req.method === "POST" && url.pathname.startsWith("/api/agents/") && url.pathname.endsWith("/approval")) {
      const id = url.pathname.split("/")[3];
      const agent = agents.get(id);
      if (!agent) {
        json(res, 404, { error: "未找到小人。" });
        return;
      }
      const body = await parseBody(req);
      answerAgentApproval(agent, body.decision);
      json(res, 200, { agent: getAgentSnapshot(agent) });
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/agents/") && url.pathname.endsWith("/prompt")) {
      const id = url.pathname.split("/")[3];
      const agent = agents.get(id);
      if (!agent) {
        json(res, 404, { error: "未找到小人。" });
        return;
      }
      const body = await parseBody(req);
      agent.prompt = String(body.prompt || "");
      sendEvent(id, { type: "system", text: "任务说明已更新。" });
      json(res, 200, { agent: getAgentSnapshot(agent) });
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/agents/") && url.pathname.endsWith("/profile")) {
      const id = url.pathname.split("/")[3];
      const agent = agents.get(id);
      if (!agent) {
        json(res, 404, { error: "未找到小人。" });
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
      sendEvent(id, { type: "system", text: "小人资料已更新。" });
      json(res, 200, { agent: getAgentSnapshot(agent) });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/agents/") && url.pathname.endsWith("/events")) {
      const id = url.pathname.split("/")[3];
      const agent = agents.get(id);
      if (!agent) {
        json(res, 404, { error: "未找到小人。" });
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

    json(res, 404, { error: "未找到接口。" });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

await ensureData();
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Vibe Coding Club bridge listening on http://127.0.0.1:${PORT}`);
});
