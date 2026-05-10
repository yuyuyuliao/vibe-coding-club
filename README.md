# Vibe Coding Club

Vibe Coding Club 是一个本地 Web 控制台，用“项目房间 + Codex 小人”的方式管理多个编码任务。每个房间绑定一个本地项目目录，小人会在对应目录中启动 Codex CLI，并通过页面展示状态、任务、对话记录和基础管理操作。

## 功能特性

- 创建项目房间，绑定本地代码目录。
- 检测本机 `codex` CLI 是否可用。
- 为当前房间创建 Codex 小人并下发任务提示词。
- 查看小人运行状态、PID、活动时间、事件记录和对话摘要。
- 编辑小人的任务提示词、名称、造型和房间位置。
- 自定义房间名称、地板和墙面主题。
- 删除小人时同步终止对应的 Codex CLI 进程。

## 技术栈

- Vue 3
- Vite 5
- Node.js HTTP bridge
- Server-Sent Events，用于向前端推送小人事件

## 环境要求

- Node.js 18 或更新版本。
- 已安装依赖：`npm install`
- 如需创建可工作的 Codex 小人，本机 `PATH` 中需要能执行 `codex`。

可以用下面的命令确认 Codex CLI：

```bash
codex --version
```

## 快速开始

安装依赖：

```bash
npm install
```

启动前端和本地 bridge 服务：

```bash
npm run dev
```

默认地址：

- Web 页面：`http://127.0.0.1:5173`
- Bridge API：`http://127.0.0.1:4177`

打开页面后，先创建一个项目房间并填写本地项目目录，再生成 Codex 小人执行任务。

## 可用脚本

```bash
npm run dev
```

同时启动 bridge 服务和 Vite 开发服务器。

```bash
npm run bridge
```

只启动本地 bridge 服务，默认监听 `127.0.0.1:4177`。可通过 `CLUB_BRIDGE_PORT` 修改端口。

```bash
npm run vite
```

只启动 Vite 开发服务器。

```bash
npm run build
```

构建生产版本到 `dist/`。

```bash
npm run preview
```

预览已构建的生产版本。

## 项目结构

```text
.
├── index.html
├── package.json
├── scripts/
│   └── dev.mjs          # 同时启动 bridge 和 Vite
├── server/
│   └── bridge.mjs       # 本地 API、房间存储、Codex 进程管理、SSE 推送
├── src/
│   ├── App.vue          # 主界面和交互逻辑
│   ├── main.js          # Vue 入口
│   └── styles.css       # 页面样式
└── vite.config.js
```

## 数据存储

房间数据保存在本地 `data/rooms.json`。该目录已加入 `.gitignore`，不会默认提交到仓库。

小人进程、事件和消息记录目前保存在 bridge 服务的内存中，重启服务后会清空。

## 工作方式

1. 前端通过 `VITE_BRIDGE_URL` 连接本地 bridge，默认是 `http://127.0.0.1:4177`。
2. Bridge 读取和写入房间配置，并检测本机 `codex` CLI。
3. 创建小人时，bridge 会在房间绑定的目录中启动 Codex CLI。
4. 前端使用 SSE 订阅小人事件，用于刷新状态、活动时间和事件列表。

## 注意事项

- 这是本地开发工具，bridge 默认允许跨域访问并监听本机地址，不建议直接暴露到公网。
- 小人会在你填写的项目目录中启动 Codex CLI，请确认目录路径正确。
- 删除小人会终止对应的 Codex CLI 进程。
- 如果页面提示未检测到 Codex，请确认 `codex` 命令已经安装并加入 `PATH`。
