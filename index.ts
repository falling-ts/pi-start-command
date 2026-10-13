/**
 * pi-start-command — 在会话真正开始前运行一条配置好的启动命令。
 *
 * 参考 dsh-start-command（DSH 同名插件）的语义移植到 pi 扩展 API：
 *
 *   dsh 挂点 `agent/pre-step`（UserPromptSubmit 的 waterfall，请求派生前最后
 *   一个扩展点）↔ pi 挂点 `before_agent_start`（pi await 全部 handler 后才
 *   组装并派发模型请求）。在 handler 里 await 命令即满足"先跑命令、
 *   再发请求"，且不触碰 agent 循环本身。
 *
 * 触发条件（对应 dsh 版的五道门槛中 pi 可表达的部分）：
 *   1. 配置了命令（环境变量 `PI_START_COMMAND`，空/未设 = 整个插件静默跳过）；
 *   2. `event.messageType === "user"` —— 只对用户提交的 prompt 生效。pi v1.2.0 起
 *      `before_agent_start` 也为 `pi.sendMessage(..., { triggerTurn: true })` 触发
 *      （`"custom"` 变体），程序化启动的 run 不算"用户发起了会话"；
 *   3. 每个 run 只触发一次 —— `before_agent_start` 本身就是 run 级事件，
 *      一轮内的后续工具循环步不会再次进入，天然具备 dsh 版 turn latch 的幂等性。
 *
 * 失败策略与 dsh 版一致：任何失败（非零退出、超时、spawn 失败）只经
 * `ctx.ui.notify` 告知并放行，绝不让异常逃进事件分发 —— 启动命令必须
 * 无法破坏模型请求。
 *
 * 配置（环境变量）：
 *   - `PI_START_COMMAND`           要运行的命令行；未设或空白则插件完全静默。
 *   - `PI_START_COMMAND_TIMEOUT_MS` 超时毫秒数，默认 10000；到点 kill 进程并放行。
 *   - `PI_START_COMMAND_QUIET`     设为 `1` 时成功也不弹通知，只报失败。
 *
 * 工作目录：`ctx.cwd`（当前会话的工作目录），与 dsh 版取 session cwd 对齐。
 *
 * 安装：把本目录软链到 `~/.pi/agent/extensions/pi-start-command` 即可
 * （pi 扫描 extensions 目录，按目录内的 `index.ts` 入口经 jiti 加载）。
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 默认超时：启动命令不应长期阻塞会话开始。 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** stdout/stderr 尾部带入通知的字符上限（日志边界，不是行为边界）。 */
const LOG_TAIL_CHARS = 400;

/** 读取配置的启动命令，规范化：非字符串或空白视为未配置。 */
function readStartCommand(): string | undefined {
	const raw = process.env.PI_START_COMMAND;
	if (typeof raw !== "string") return undefined;
	const command = raw.trim();
	return command === "" ? undefined : command;
}

/** 解析超时毫秒数：非法或非正数回退默认值。 */
function resolveTimeoutMs(): number {
	const raw = Number(process.env.PI_START_COMMAND_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/** 是否静默成功（只报失败）。 */
function isQuiet(): boolean {
	return process.env.PI_START_COMMAND_QUIET === "1";
}

/** 文本末尾至多 `LOG_TAIL_CHARS` 字符；空白返回 undefined。 */
function tail(text: string | undefined): string | undefined {
	if (typeof text !== "string") return undefined;
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	return trimmed.length > LOG_TAIL_CHARS ? `…${trimmed.slice(-LOG_TAIL_CHARS)}` : trimmed;
}

/** 一次命令执行的结果；`ran` 区分"进程起来了"与"根本没起来"。 */
interface CommandOutcome {
	ran: boolean;
	reason: string;
	exitCode?: number;
	timedOut?: boolean;
	aborted?: boolean;
	durationMs: number;
	stdoutTail?: string;
	stderrTail?: string;
	error?: string;
}

/**
 * 运行一条启动命令。绝不抛出。
 *
 * 用 `spawn` 而非 `exec`：命令行整体交给系统 shell 解析（Windows 为 cmd），
 * `windowsHide` 避免闪终端窗口；超时到点 kill；输出只取尾部用于通知。
 */
function runStartCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandOutcome> {
	return new Promise((resolve) => {
		const started = Date.now();
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, {
				shell: true,
				cwd,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			resolve({
				ran: false,
				reason: "spawn-failed",
				durationMs: Date.now() - started,
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeoutMs);

		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({
				ran: false,
				reason: "spawn-failed",
				durationMs: Date.now() - started,
				error: error.message,
			});
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({
				ran: true,
				reason: "completed",
				...(code !== null ? { exitCode: code } : {}),
				...(timedOut ? { timedOut: true } : {}),
				...(signal !== null ? { aborted: true } : {}),
				durationMs: Date.now() - started,
				...(tail(stdout) !== undefined ? { stdoutTail: tail(stdout) } : {}),
				...(tail(stderr) !== undefined ? { stderrTail: tail(stderr) } : {}),
			});
		});
	});
}

/** 把一次结果渲染成单行通知文本；失败时级别为 warning。 */
function describeOutcome(command: string, outcome: CommandOutcome): { level: "info" | "warning"; text: string } {
	const parts = [`[start-command] "${command}"`];
	if (outcome.ran !== true) {
		parts.push(`未运行 (${outcome.reason})`);
		if (outcome.error !== undefined) parts.push(`error=${outcome.error}`);
	} else {
		parts.push(`exit=${outcome.exitCode ?? "signal"}`);
		if (outcome.timedOut === true) parts.push("超时");
	}
	parts.push(`${outcome.durationMs}ms`);
	if (outcome.stdoutTail !== undefined) parts.push(`stdout=${outcome.stdoutTail}`);
	if (outcome.stderrTail !== undefined) parts.push(`stderr=${outcome.stderrTail}`);
	const failed =
		outcome.ran !== true ||
		outcome.timedOut === true ||
		outcome.aborted === true ||
		(outcome.exitCode !== undefined && outcome.exitCode !== 0);
	return { level: failed ? "warning" : "info", text: parts.join(" ") };
}

export default function piStartCommand(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		// 只对用户提交的 prompt 生效；程序化触发的 run（custom message）跳过。
		if (event.messageType !== "user") return;

		const command = readStartCommand();
		if (command === undefined) return;

		const outcome = await runStartCommand(command, ctx.cwd, resolveTimeoutMs());
		const line = describeOutcome(command, outcome);
		if (ctx.hasUI && (line.level === "warning" || !isQuiet())) {
			ctx.ui.notify(line.text, line.level);
		}
		return;
	});
}
