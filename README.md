# pi-start-command

pi 扩展：在会话真正开始前运行一条配置好的启动命令。参考 [dsh-start-command](https://github.com/falling-ts/dsh-start-command)（DSH 同名插件）移植到 pi 扩展 API。

## 工作原理

挂点为 `before_agent_start`：pi 会 await 全部 handler 之后才组装并派发模型请求，因此在这里 await 命令即满足「先跑命令、再发请求」。命令完成后本轮 prompt 才到达模型。

触发条件（全部满足才运行）：

1. 配置了命令（`PI_START_COMMAND` 未设或空白时插件完全静默，零副作用）；
2. `event.messageType === "user"`——只对用户提交的 prompt 生效。pi v1.2.0 起 `before_agent_start` 也会为 `pi.sendMessage(..., { triggerTurn: true })` 触发（`"custom"` 变体），程序化启动的 run 不算「用户发起了会话」；
3. `before_agent_start` 是 run 级事件，一轮内的后续工具循环步不会再次进入，天然幂等。

失败策略：任何失败（非零退出、超时、spawn 失败）只经 `ctx.ui.notify` 告知并放行，绝不抛进事件分发——启动命令必须无法破坏模型请求。

## 配置（环境变量）

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PI_START_COMMAND` | 要运行的命令行；未设或空白则插件完全静默 | （未配置） |
| `PI_START_COMMAND_TIMEOUT_MS` | 超时毫秒数，到点 kill 进程并放行 | `10000` |
| `PI_START_COMMAND_QUIET` | 设为 `1` 时成功也不弹通知，只报失败 | （关闭） |

工作目录为当前会话的 `ctx.cwd`。命令行整体交给系统 shell 解析（Windows 为 cmd），`windowsHide` 避免闪终端窗口。

## 安装

方式一（软链本仓库，随仓库更新）：

```powershell
New-Item -ItemType SymbolicLink `
  -Path "$env:USERPROFILE\.pi\agent\extensions\pi-start-command" `
  -Target "D:\AI\pi-s\pi-start-command"
```

方式二（npm 包）：`pi install npm:pi-start-command`（需代理）。

pi 通过 jiti 直接加载 `.ts`，无需构建。

## 使用示例

```powershell
# 每次会话开始前同步一次远程状态
$env:PI_START_COMMAND = "git fetch --all --quiet"

# 自定义超时 30 秒，成功静默
$env:PI_START_COMMAND_TIMEOUT_MS = "30000"
$env:PI_START_COMMAND_QUIET = "1"
```

通知示例：

- 成功：`[start-command] "git fetch --all --quiet" exit=0 812ms`
- 失败：`[start-command] "npm test" exit=1 4503ms stdout=… stderr=…`

## License

MIT
