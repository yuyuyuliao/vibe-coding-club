<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";

const bridgeUrl = import.meta.env.VITE_BRIDGE_URL || "http://127.0.0.1:4177";

const state = reactive({
  cli: { codex: { available: false, path: "", version: "" } },
  rooms: [],
  agents: [],
  selectedRoomId: "",
  selectedAgentId: "",
  draftRoom: { name: "", path: "" },
  prompt: "查看当前项目结构，告诉我下一步适合做什么。",
  roomSettingsOpen: false,
  error: ""
});

const now = ref(Date.now());
const popoverMode = ref("status");
const copiedAgentId = ref("");
const isDraggingAgent = ref(false);
const hiddenApprovalId = ref("");
let clock;

const GRID_COLS = 6;
const GRID_ROWS = 3;
const STATION_WIDTH = 161;
const STATION_HEIGHT = 214;

const selectedRoom = computed(() => state.rooms.find((room) => room.id === state.selectedRoomId));
const activeAgents = computed(() => state.agents.filter((agent) => agent.roomId === state.selectedRoomId));
const selectedAgent = computed(() => {
  if (!state.selectedAgentId) return null;
  return activeAgents.value.find((agent) => agent.id === state.selectedAgentId) || null;
});
const approvalAgent = computed(() =>
  state.agents.find((agent) => agent.pendingApproval && agent.pendingApproval.id !== hiddenApprovalId.value) || null
);

const hairColors = ["#25323a", "#7a4b35", "#d6a34a", "#5b6472", "#8f4da8"];
const bodyColors = ["#2d8f7b", "#3b82f6", "#d65f5f", "#7c5bd6", "#e0a33c"];
const hairStyles = [
  { value: "short", label: "短发" },
  { value: "bob", label: "圆发" },
  { value: "spike", label: "翘发" },
  { value: "curls", label: "卷发" },
  { value: "cap", label: "帽檐" }
];
const accessories = [
  { value: "none", label: "无" },
  { value: "glasses", label: "眼镜" },
  { value: "headset", label: "耳机" }
];
const floorThemes = [
  { value: "wood", label: "木地板" },
  { value: "grid", label: "网格地板" },
  { value: "carpet", label: "软毯" },
  { value: "studio", label: "工作室" }
];
const wallThemes = [
  { value: "morning", label: "晨光" },
  { value: "focus", label: "专注" },
  { value: "night", label: "夜间" },
  { value: "mint", label: "薄荷" }
];
const popoverModes = [
  { value: "status", label: "状态" },
  { value: "chat", label: "对话" },
  { value: "cli", label: "CLI" },
  { value: "cli-detail", label: "详细CLI" },
  { value: "task", label: "任务" },
  { value: "style", label: "造型" },
  { value: "remove", label: "移除" }
];

async function api(path, options = {}) {
  const response = await fetch(`${bridgeUrl}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function normalizeRoom(room) {
  return {
    ...room,
    settings: {
      floor: room.settings?.floor || "wood",
      wall: room.settings?.wall || "morning"
    }
  };
}

function hydrateAgent(agent) {
  const messages = agent.messages || [];
  return {
    ...agent,
    name: agent.name || "Codex 小人",
    style: {
      hair: agent.style?.hair || "#25323a",
      hairStyle: agent.style?.hairStyle || "short",
      body: agent.style?.body || "#2d8f7b",
      accessory: agent.style?.accessory || "none"
    },
    position: agent.position || null,
    events: agent.events || [],
    messages,
    pendingApproval: agent.pendingApproval || null,
    messagesHydratedUntil: messages[messages.length - 1]?.at || ""
  };
}

async function refresh() {
  const [cli, rooms, agents] = await Promise.all([
    api("/api/cli/detect"),
    api("/api/rooms"),
    api("/api/agents")
  ]);
  state.cli = cli;
  state.rooms = rooms.rooms.map(normalizeRoom);
  state.agents = agents.agents.map(hydrateAgent);
  if (!state.selectedRoomId && state.rooms.length) state.selectedRoomId = state.rooms[0].id;
}

async function createRoom() {
  state.error = "";
  if (!state.draftRoom.path.trim()) {
    state.error = "请输入本地项目目录。";
    return;
  }
  const { room } = await api("/api/rooms", {
    method: "POST",
    body: JSON.stringify(state.draftRoom)
  });
  state.rooms.push(normalizeRoom(room));
  state.selectedRoomId = room.id;
  state.selectedAgentId = "";
  state.draftRoom.name = "";
  state.draftRoom.path = "";
}

async function saveRoomSettings() {
  if (!selectedRoom.value) return;
  const { room } = await api(`/api/rooms/${selectedRoom.value.id}/settings`, {
    method: "POST",
    body: JSON.stringify({
      name: selectedRoom.value.name,
      settings: selectedRoom.value.settings
    })
  });
  const index = state.rooms.findIndex((item) => item.id === room.id);
  if (index >= 0) state.rooms[index] = normalizeRoom(room);
}

function subscribe(agentId) {
  const stream = new EventSource(`${bridgeUrl}/api/agents/${agentId}/events`);
  stream.onmessage = (message) => {
    const event = JSON.parse(message.data);
    const stampedEvent = { ...event, at: event.at || new Date().toISOString() };
    const agent = state.agents.find((item) => item.id === agentId);
    if (!agent) return;

    agent.status = stampedEvent.status || agent.status;
    agent.lastActivityAt = stampedEvent.at;
    if (stampedEvent.type === "stdout" || stampedEvent.type === "stderr") {
      agent.outputCount = (agent.outputCount || 0) + 1;
    }
    if (stampedEvent.type === "approval") {
      agent.pendingApproval = stampedEvent.approval || {
        id: `${agent.id}-${stampedEvent.at}`,
        text: stampedEvent.text,
        createdAt: stampedEvent.at
      };
      hiddenApprovalId.value = "";
      state.selectedAgentId = agent.id;
    }
    if (stampedEvent.type === "approval-resolved") {
      agent.pendingApproval = null;
    }
    if (stampedEvent.type !== "heartbeat") agent.events.push(stampedEvent);

    const isNewMessage =
      !agent.messagesHydratedUntil || new Date(stampedEvent.at).getTime() > new Date(agent.messagesHydratedUntil).getTime();
    if (isNewMessage && stampedEvent.type === "stdout") appendAgentMessage(agent, "assistant", stampedEvent.text);
    if (isNewMessage && stampedEvent.type === "human") appendAgentMessage(agent, "user", stampedEvent.text);
  };
}

function cleanText(text) {
  return String(text || "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, "")
    .replace(/\r/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function appendAgentMessage(agent, role, content) {
  const cleaned = cleanText(content);
  if (!cleaned) return;
  agent.messages = agent.messages || [];
  const last = agent.messages[agent.messages.length - 1];
  if (last?.role === role && role === "assistant") {
    last.content = `${last.content}\n${cleaned}`.trim();
    last.at = new Date().toISOString();
    return;
  }
  agent.messages.push({
    id: crypto.randomUUID(),
    role,
    content: cleaned,
    at: new Date().toISOString()
  });
}

async function createAgent() {
  state.error = "";
  if (!selectedRoom.value) {
    state.error = "请先创建或选择一个房间。";
    return;
  }
  if (!state.cli.codex.available) {
    state.error = "未检测到 codex CLI，请先确认本机 PATH 中可以执行 codex。";
    return;
  }
  const { agent } = await api("/api/agents", {
    method: "POST",
    body: JSON.stringify({ roomId: selectedRoom.value.id, tool: "codex", prompt: state.prompt })
  });
  state.agents.push(hydrateAgent(agent));
  state.selectedAgentId = agent.id;
  popoverMode.value = "status";
  subscribe(agent.id);
}

async function sendTextToAgent(agent, input) {
  if (!agent || !String(input || "").trim()) return;
  await api(`/api/agents/${agent.id}/input`, {
    method: "POST",
    body: JSON.stringify({ input })
  });
}

async function answerAgentApproval(agent, decision) {
  if (!agent) return;
  if (decision === "later") {
    hiddenApprovalId.value = agent.pendingApproval?.id || agent.id;
    return;
  }
  try {
    const { agent: updated } = await api(`/api/agents/${agent.id}/approval`, {
      method: "POST",
      body: JSON.stringify({ decision })
    });
    agent.pendingApproval = updated.pendingApproval || null;
    if (!agent.pendingApproval) hiddenApprovalId.value = "";
  } catch (error) {
    state.error = `发送确认失败：${error.message}`;
  }
}

async function saveAgentPrompt(agent) {
  if (!agent) return;
  await api(`/api/agents/${agent.id}/prompt`, {
    method: "POST",
    body: JSON.stringify({ prompt: agent.prompt })
  });
}

async function saveAgentProfile(agent) {
  if (!agent) return;
  const { agent: updated } = await api(`/api/agents/${agent.id}/profile`, {
    method: "POST",
    body: JSON.stringify({ name: agent.name, style: agent.style, position: agent.position || null })
  });
  agent.name = updated.name;
  agent.style = updated.style;
  agent.position = updated.position || null;
}

async function sendPromptRevision(agent) {
  if (!agent) return;
  await saveAgentPrompt(agent);
  await sendTextToAgent(agent, agent.prompt);
}

async function copyAgentConversation(agent) {
  if (!agent) return;
  const content = (agent.messages || [])
    .map((message) => `${message.role === "user" ? "你" : "小人"}：\n${message.content}`)
    .join("\n\n");
  if (!content.trim()) return;
  await navigator.clipboard.writeText(content);
  copiedAgentId.value = agent.id;
  window.setTimeout(() => {
    if (copiedAgentId.value === agent.id) copiedAgentId.value = "";
  }, 1400);
}

async function removeAgent(agent) {
  if (!agent) return;
  try {
    await api(`/api/agents/${agent.id}`, { method: "DELETE" });
    state.agents = state.agents.filter((item) => item.id !== agent.id);
    if (state.selectedAgentId === agent.id) {
      const nextAgent = state.agents.find((item) => item.roomId === state.selectedRoomId);
      state.selectedAgentId = nextAgent?.id || "";
    }
  } catch (error) {
    state.error = `移除小人失败：${error.message}`;
  }
}

function onAgentDragStart(event, agent) {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/x-agent-id", agent.id);
  event.dataTransfer.setData("text/plain", agent.id);
  isDraggingAgent.value = true;
  clearSelectedAgent();
}

async function onDrop(event) {
  const agentId = event.dataTransfer.getData("application/x-agent-id") || event.dataTransfer.getData("text/plain");
  const agent = state.agents.find((item) => item.id === agentId);
  isDraggingAgent.value = false;
  if (!agent) return;
  const row = event.currentTarget.querySelector(".agent-row");
  if (!row) return;
  const rect = row.getBoundingClientRect();
  const station = nearestStation(event.clientX - rect.left, event.clientY - rect.top);
  if (isStationOccupied(station, agent.id)) {
    state.error = "这个工位已经有小人了，请换一个空工位。";
    return;
  }
  agent.position = stationToPosition(station);
  clearSelectedAgent();
  await saveAgentProfile(agent);
}

function onDragEnd() {
  isDraggingAgent.value = false;
}

function agentSlotStyle(agent) {
  const position = agent.position || stationToPosition(defaultStationFor(agent));
  return {
    position: "absolute",
    left: `${position.x}px`,
    top: `${position.y}px`
  };
}

function popoverPlacement(agent) {
  const station = positionToStation(agent.position) || defaultStationFor(agent);
  return station.row <= 1 ? "popover-below" : "popover-above";
}

function nearestStation(x, y) {
  const col = Math.max(0, Math.min(GRID_COLS - 1, Math.floor(x / STATION_WIDTH)));
  const row = Math.max(0, Math.min(GRID_ROWS - 1, Math.floor(y / STATION_HEIGHT)));
  return { col, row };
}

function stationToPosition(station) {
  return {
    x: station.col * STATION_WIDTH + Math.floor((STATION_WIDTH - 136) / 2),
    y: station.row * STATION_HEIGHT + 4
  };
}

function positionToStation(position) {
  if (!position) return null;
  return {
    col: Math.max(0, Math.min(GRID_COLS - 1, Math.round((position.x - Math.floor((STATION_WIDTH - 136) / 2)) / STATION_WIDTH))),
    row: Math.max(0, Math.min(GRID_ROWS - 1, Math.round((position.y - 4) / STATION_HEIGHT)))
  };
}

function isSameStation(a, b) {
  return a?.col === b?.col && a?.row === b?.row;
}

function isStationOccupied(station, ignoredAgentId = "") {
  return activeAgents.value.some((agent) => {
    if (agent.id === ignoredAgentId) return false;
    return isSameStation(positionToStation(agent.position), station);
  });
}

function firstFreeStation(ignoredAgentId = "") {
  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLS; col += 1) {
      const station = { col, row };
      if (!isStationOccupied(station, ignoredAgentId)) return station;
    }
  }
  return { col: 0, row: 0 };
}

function defaultStationFor(agent) {
  const occupied = new Set(
    activeAgents.value
      .filter((item) => item.position && item.id !== agent.id)
      .map((item) => {
        const station = positionToStation(item.position);
        return `${station.col}:${station.row}`;
      })
  );
  const floatingAgents = activeAgents.value.filter((item) => !item.position);
  const ownIndex = floatingAgents.findIndex((item) => item.id === agent.id);
  let seen = 0;
  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLS; col += 1) {
      if (occupied.has(`${col}:${row}`)) continue;
      if (seen === ownIndex) return { col, row };
      seen += 1;
    }
  }
  return { col: 0, row: 0 };
}

function eventClass(type) {
  return {
    stdout: "cli-stdout",
    stderr: "cli-stderr",
    error: "cli-stderr",
    approval: "cli-stderr",
    "approval-resolved": "cli-system",
    human: "cli-human",
    detail: "cli-system",
    system: "cli-system"
  }[type] || "cli-system";
}

function eventTypeLabel(type) {
  return {
    stdout: "输出",
    stderr: "错误输出",
    error: "错误",
    approval: "确认",
    "approval-resolved": "确认结果",
    human: "输入",
    detail: "详细",
    system: "系统",
    heartbeat: "心跳"
  }[type] || "事件";
}

function visibleCliEvents(agent) {
  return (agent.events || []).filter((event) => event.type === "stdout" && cleanText(event.text));
}

function detailedCliEvents(agent) {
  return (agent.events || []).filter((event) => event.type !== "heartbeat" && cleanText(event.text));
}

function statusLabel(status) {
  return {
    starting: "启动中",
    running: "工作中",
    idle: "待命中",
    "needs-human": "等你确认",
    done: "已完成"
  }[status] || status;
}

function secondsSince(value) {
  if (!value) return "-";
  return Math.max(0, Math.floor((now.value - new Date(value).getTime()) / 1000));
}

function durationSince(value) {
  if (!value) return "0s";
  const seconds = secondsSince(value);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function activityText(agent) {
  if (!agent) return "待启动";
  if (agent.status === "idle") return "待命中";
  if (agent.status === "done") return "任务已结束";
  if (agent.status === "needs-human") return "需要人工确认";
  const quietSeconds = secondsSince(agent.lastActivityAt);
  if (quietSeconds <= 6) return "刚刚有活动";
  return `${quietSeconds}s 未输出，进程仍在运行`;
}

function selectAgent(agentId) {
  state.selectedAgentId = agentId;
  popoverMode.value = "status";
}

function clearSelectedAgent() {
  state.selectedAgentId = "";
}

function selectRoom(roomId) {
  state.selectedRoomId = roomId;
  clearSelectedAgent();
}

onMounted(async () => {
  try {
    clock = setInterval(() => {
      now.value = Date.now();
    }, 1000);
    await refresh();
    state.agents.forEach((agent) => subscribe(agent.id));
  } catch (error) {
    state.error = error.message;
  }
});

onUnmounted(() => {
  clearInterval(clock);
});
</script>

<template>
  <main class="app-shell">
    <aside class="side-panel">
      <div class="brand">
        <div class="brand-mark">VC</div>
        <div>
          <h1>Vibe Coding Club</h1>
          <p>本地 coding cli 俱乐部</p>
        </div>
      </div>

      <section class="panel-block">
        <div class="section-title">
          <span>创建房间</span>
        </div>
        <label>
          房间名
          <input v-model="state.draftRoom.name" placeholder="例如：官网改版" />
        </label>
        <label>
          项目目录
          <input v-model="state.draftRoom.path" placeholder="D:\Web Project\my-app" />
        </label>
        <button class="primary-button" @click="createRoom">创建房间</button>
      </section>

      <section class="panel-block room-list">
        <div class="section-title">
          <span>项目房间</span>
          <small>{{ state.rooms.length }}</small>
        </div>
        <button
          v-for="room in state.rooms"
          :key="room.id"
          class="room-item"
          :class="{ active: room.id === state.selectedRoomId }"
          @click="selectRoom(room.id)"
        >
          <span>{{ room.name }}</span>
          <small>{{ room.path }}</small>
        </button>
      </section>
    </aside>

    <section class="club-floor">
      <header class="top-bar">
        <div>
          <p>当前房间</p>
          <h2>{{ selectedRoom?.name || "还没有房间" }}</h2>
        </div>
        <div class="toolbar">
          <button
            class="room-gear-button"
            title="房间设置"
            :disabled="!selectedRoom"
            @click="state.roomSettingsOpen = !state.roomSettingsOpen"
          >
            ⚙
          </button>
          <button class="primary-button" @click="createAgent">生成小人</button>
        </div>

        <section v-if="state.roomSettingsOpen && selectedRoom" class="room-settings-popover">
          <div class="section-title">
            <span>房间设置</span>
            <button class="icon-button" title="关闭" @click="state.roomSettingsOpen = false">×</button>
          </div>
          <label>
            房间名
            <input v-model="selectedRoom.name" maxlength="40" @blur="saveRoomSettings" />
          </label>
          <div class="custom-row">
            <span>地板</span>
            <div class="segment-row">
              <button
                v-for="item in floorThemes"
                :key="item.value"
                class="segment-button"
                :class="{ active: selectedRoom.settings.floor === item.value }"
                @click="selectedRoom.settings.floor = item.value; saveRoomSettings()"
              >
                {{ item.label }}
              </button>
            </div>
          </div>
          <div class="custom-row">
            <span>墙面</span>
            <div class="segment-row">
              <button
                v-for="item in wallThemes"
                :key="item.value"
                class="segment-button"
                :class="{ active: selectedRoom.settings.wall === item.value }"
                @click="selectedRoom.settings.wall = item.value; saveRoomSettings()"
              >
                {{ item.label }}
              </button>
            </div>
          </div>
        </section>
      </header>

      <div class="workspace-grid">
        <section
          class="room-stage"
          :class="[
            selectedRoom ? `floor-${selectedRoom.settings.floor}` : '',
            selectedRoom ? `wall-${selectedRoom.settings.wall}` : ''
          ]"
          @click="clearSelectedAgent"
          @dragover.prevent
          @drop="onDrop"
        >
          <div v-if="!selectedRoom" class="empty-state">
            <h3>先创建一个项目房间</h3>
            <p>每个房间绑定一个本地目录，小人会在对应目录里启动 CLI。</p>
          </div>

          <template v-else>
            <div class="room-sign">
              <span>{{ selectedRoom.path }}</span>
            </div>

            <div v-if="isDraggingAgent" class="station-grid" aria-hidden="true">
              <span
                v-for="index in GRID_COLS * GRID_ROWS"
                :key="index"
                class="station-cell"
              ></span>
            </div>

            <div class="agent-row">
              <div
                v-for="agent in activeAgents"
                :key="agent.id"
                class="agent-slot"
                :style="agentSlotStyle(agent)"
                @click.stop
              >
                <article
                  class="agent-card"
                  :class="[agent.status, { selected: agent.id === selectedAgent?.id }]"
                  draggable="true"
                  role="button"
                  tabindex="0"
                  @click="selectAgent(agent.id)"
                  @keydown.enter="selectAgent(agent.id)"
                  @dragstart="onAgentDragStart($event, agent)"
                  @dragend="onDragEnd"
                >
                  <span class="agent-pulse" :title="activityText(agent)"></span>
                  <div
                    class="agent-visual"
                    :style="{ '--hair-color': agent.style.hair, '--body-color': agent.style.body }"
                  >
                    <span class="hair" :class="agent.style.hairStyle"></span>
                    <span class="face"></span>
                    <span v-if="agent.style.accessory === 'glasses'" class="accessory glasses"></span>
                    <span v-if="agent.style.accessory === 'headset'" class="accessory headset"></span>
                    <span class="body"></span>
                  </div>
                  <div class="agent-meta">
                    <strong>{{ agent.name }}</strong>
                    <small>{{ statusLabel(agent.status) }} · PID {{ agent.pid || "-" }}</small>
                    <em>{{ activityText(agent) }}</em>
                  </div>
                </article>

                <section
                  v-if="!isDraggingAgent && agent.id === selectedAgent?.id"
                  class="agent-popover"
                  :class="popoverPlacement(agent)"
                  @click.stop
                >
                  <div class="popover-title">
                    <strong>{{ agent.name }}</strong>
                    <span>{{ statusLabel(agent.status) }}</span>
                  </div>

                  <div class="popover-tabs">
                    <button
                      v-for="mode in popoverModes"
                      :key="mode.value"
                      class="segment-button"
                      :class="{ active: popoverMode === mode.value }"
                      @click.stop="popoverMode = mode.value"
                    >
                      {{ mode.label }}
                    </button>
                  </div>

                  <div v-if="popoverMode === 'status'" class="popover-body">
                    <p>{{ agent.prompt || "等待任务指令" }}</p>
                    <div class="popover-stats">
                      <span>{{ durationSince(agent.startedAt) }} 运行</span>
                      <span>{{ agent.outputCount || 0 }} 次输出</span>
                      <span>{{ secondsSince(agent.lastActivityAt) }}s 前活动</span>
                    </div>
                  </div>

                  <div v-else-if="popoverMode === 'chat'" class="popover-body conversation-popover">
                    <div class="conversation-actions">
                      <span>{{ agent.messages.length }} 条文本记录</span>
                      <button
                        class="secondary-button compact-button"
                        :disabled="!agent.messages.length"
                        @click.stop="copyAgentConversation(agent)"
                      >
                        {{ copiedAgentId === agent.id ? "已复制" : "复制" }}
                      </button>
                    </div>
                    <p v-if="!agent.messages.length" class="muted">还没有文本对话。</p>
                    <div
                      v-for="message in agent.messages"
                      :key="message.id"
                      class="bubble"
                      :class="message.role === 'user' ? 'bubble-human' : 'bubble-output'"
                    >
                      <span>{{ message.role === "user" ? "你" : "小人" }}</span>
                      <pre>{{ message.content }}</pre>
                    </div>
                  </div>

                  <div v-else-if="popoverMode === 'cli'" class="popover-body cli-log-popover">
                    <p class="cli-note">当前小人使用后台 Codex 进程。这里只显示 Codex 回复内容。</p>
                    <p v-if="!visibleCliEvents(agent).length" class="muted">还没有 Codex 回复。</p>
                    <div
                      v-for="(event, index) in visibleCliEvents(agent)"
                      :key="`${event.at}-${index}`"
                      class="cli-log-line"
                      :class="eventClass(event.type)"
                    >
                      <span>{{ eventTypeLabel(event.type) }}</span>
                      <pre>{{ event.text }}</pre>
                    </div>
                  </div>

                  <div v-else-if="popoverMode === 'cli-detail'" class="popover-body cli-log-popover">
                    <p class="cli-note">这里显示启动、退出、确认、错误和 Codex 过程事件摘要。</p>
                    <p v-if="!detailedCliEvents(agent).length" class="muted">还没有详细 CLI 事件。</p>
                    <div
                      v-for="(event, index) in detailedCliEvents(agent)"
                      :key="`${event.at}-${index}`"
                      class="cli-log-line"
                      :class="eventClass(event.type)"
                    >
                      <span>{{ eventTypeLabel(event.type) }}</span>
                      <pre>{{ event.text }}</pre>
                    </div>
                  </div>

                  <div v-else-if="popoverMode === 'task'" class="popover-body">
                    <textarea v-model="agent.prompt" rows="5" @blur="saveAgentPrompt(agent)" />
                    <button class="secondary-button" @click.stop="sendPromptRevision(agent)">保存并发送给小人</button>
                  </div>

                  <div v-else-if="popoverMode === 'style'" class="popover-body custom-panel">
                    <label>
                      名称
                      <input v-model="agent.name" maxlength="24" @blur="saveAgentProfile(agent)" />
                    </label>
                    <div class="custom-row">
                      <span>发型</span>
                      <div class="segment-row">
                        <button
                          v-for="item in hairStyles"
                          :key="item.value"
                          class="segment-button"
                          :class="{ active: agent.style.hairStyle === item.value }"
                          @click.stop="agent.style.hairStyle = item.value; saveAgentProfile(agent)"
                        >
                          {{ item.label }}
                        </button>
                      </div>
                    </div>
                    <div class="custom-row">
                      <span>发色</span>
                      <div class="swatch-row">
                        <button
                          v-for="color in hairColors"
                          :key="color"
                          class="swatch-button"
                          :class="{ active: agent.style.hair === color }"
                          :style="{ backgroundColor: color }"
                          :title="color"
                          @click.stop="agent.style.hair = color; saveAgentProfile(agent)"
                        ></button>
                      </div>
                    </div>
                    <div class="custom-row">
                      <span>衣服</span>
                      <div class="swatch-row">
                        <button
                          v-for="color in bodyColors"
                          :key="color"
                          class="swatch-button"
                          :class="{ active: agent.style.body === color }"
                          :style="{ backgroundColor: color }"
                          :title="color"
                          @click.stop="agent.style.body = color; saveAgentProfile(agent)"
                        ></button>
                      </div>
                    </div>
                    <div class="custom-row">
                      <span>配件</span>
                      <div class="segment-row">
                        <button
                          v-for="item in accessories"
                          :key="item.value"
                          class="segment-button"
                          :class="{ active: agent.style.accessory === item.value }"
                          @click.stop="agent.style.accessory = item.value; saveAgentProfile(agent)"
                        >
                          {{ item.label }}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div v-else class="popover-body">
                    <p>移除小人会终止它对应的 Codex CLI 进程。</p>
                    <button class="danger-button" @click.stop="removeAgent(agent)">移除小人</button>
                  </div>
                </section>
              </div>
            </div>

            <div class="drop-hint">点击小人打开操作弹窗；按住小人可拖动它在房间里的位置。</div>
          </template>
        </section>

        <aside class="task-panel">
          <section class="panel-block cli-card compact-panel">
            <div class="section-title">
              <span>环境检测</span>
              <button class="icon-button" title="重新检测" @click="refresh">↻</button>
            </div>
            <div class="cli-row" :class="{ online: state.cli.codex.available }">
              <span class="dot"></span>
              <div>
                <strong>Codex</strong>
                <small>{{ state.cli.codex.available ? state.cli.codex.version || state.cli.codex.path : "未检测到" }}</small>
              </div>
            </div>
          </section>

          <section class="compact-panel">
            <div class="section-title">
              <span>创建小人</span>
              <small>新任务</small>
            </div>
            <textarea v-model="state.prompt" rows="6" />
            <button class="primary-button" @click="createAgent">生成 Codex 小人</button>
          </section>
        </aside>
      </div>

      <p v-if="state.error" class="error-toast">{{ state.error }}</p>

      <section v-if="approvalAgent" class="approval-overlay" @click="answerAgentApproval(approvalAgent, 'later')">
        <div class="approval-dialog" role="dialog" aria-modal="true" @click.stop>
          <div class="approval-header">
            <span>需要确认</span>
            <button class="icon-button" title="稍后处理" @click="answerAgentApproval(approvalAgent, 'later')">×</button>
          </div>
          <p>{{ approvalAgent.name }} 正在等待你确认是否继续。</p>
          <pre>{{ approvalAgent.pendingApproval.text }}</pre>
          <div class="approval-actions">
            <button class="danger-button" @click="answerAgentApproval(approvalAgent, 'no')">拒绝</button>
            <button class="secondary-button" @click="answerAgentApproval(approvalAgent, 'later')">稍后处理</button>
            <button class="primary-button" @click="answerAgentApproval(approvalAgent, 'yes')">允许</button>
          </div>
        </div>
      </section>
    </section>
  </main>
</template>
