/**
 * dsh-pet-bridge —— DSH 侧的「纯数据通道」插件。
 *
 * 只做三件事，别的都不要：
 *   1. 监听 DSH 会话事件，把「现在在做什么」压成 workStatus 段、把回合结果压成 notify 段；
 *   2. 在本机 loopback 上暴露 `GET /dsh-pet-7340/state`（{counter, sections, pets} 信封）；
 *   3. 把宿主入口写进 `<APPDATA>/dsh-pet/bridge/standalone-bridge.json`，让桌面 exe 发现本机 DSH。
 *
 * 明确不做（边界＝单一写者，见主仓 dsh-pet 的 docs/STANDALONE.md）：
 *   - 不读 exe 的配置/账本，不写任何配置文件，不轮询余额（余额归 exe 自己）；
 *   - 不画页面内宠物（没有 client 入口），不拉桌面 Helper，不写 spend.json；
 *   - 不反向调用 DSH 的业务服务。
 *
 * 这样这一份代码可以单独发版、单独装，桌面 exe 更新不会牵连它；DSH 不在时 exe 照常独立运行。
 *
 * @module dsh-pet-bridge
 */
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 路由前缀：必须与主仓 `src/shared/constants.ts` 的 ROUTE_SEGMENT 一致（exe 按它拼 URL）。 */
export const ROUTE_SEGMENT = '/dsh-pet-7340';

/** 桥描述文件名：exe 每秒读它拿 origin。 */
export const BRIDGE_DESCRIPTOR_FILE = 'standalone-bridge.json';

/** 描述文件格式版本。 */
export const BRIDGE_DESCRIPTOR_VERSION = 1;

/** 公布重试：宿主刚起时 webServer 可能还没 listen，getOrigin 会抛。 */
export const ANNOUNCE_RETRY_MS = 250;
export const ANNOUNCE_MAX_ATTEMPTS = 60;

/** 任务详情文案上限（按码点算，超出截断加省略号），与主仓 TASK_TEXT_MAX 一致。 */
export const TASK_TEXT_MAX = 40;

/** 工作状态档位：顺序必须与主仓 HOST_WORK_STATUS_STATES 一致。 */
export const WORK_STATUS_STATES = ['thinking', 'working', 'result', 'waiting', 'success', 'error'];

/** 外部槽（非真实 DSH 会话）的会话 id：写进段里时归一成 null。 */
export const EXTERNAL_WORK_SESSION = 'api';

/** 问用户问题的工具：这不是「干活」，是「等用户答复」。 */
const USER_QUESTION_TOOL = 'ask_user_question';

/**
 * 桥目录：`<APPDATA>/dsh-pet/bridge`（Windows），非 Windows 回落 `~/.config/dsh-pet/bridge`。
 * 只放两件东西：本插件写的 standalone-bridge.json、exe 写的 standalone-running.json。
 */
export function bridgeDir(env = process.env) {
  const appData = env.APPDATA;
  if (typeof appData === 'string' && appData.length > 0) return join(appData, 'dsh-pet', 'bridge');
  const home = env.HOME ?? env.USERPROFILE ?? '.';
  return join(home, '.config', 'dsh-pet', 'bridge');
}

/** 只放行 http(s) 入口，并归一化成 origin。非法输入返回 undefined（不写描述文件）。 */
export function normalizeBridgeOrigin(value) {
  if (typeof value !== 'string') return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return url.origin;
}

/** 回合结束原因 → 档位；null = 清空回空闲。 */
export function turnEndState(kind) {
  if (kind === 'completed') return 'success';
  if (kind === 'error' || kind === 'max-tokens' || kind === 'timeout') return 'error';
  return null;
}

/**
 * 会话事件 → 工作状态档位；不关心的返回 null（不切状态）。
 * 与主仓 `reduceWorkStatus` 同构（去掉 goal 续跑轮的终局细分：目标收尾轮用 success 而不是 result）。
 */
export function reduceWorkStatus(event) {
  const type = event && typeof event === 'object' ? event.type : undefined;
  const data = event && typeof event === 'object' ? event.data : undefined;
  switch (type) {
    case 'turn/start':
      return 'thinking';
    case 'tool/call':
      return String(data?.name ?? '') === USER_QUESTION_TOOL ? 'waiting' : 'working';
    case 'tool/result':
      return 'result';
    case 'approval/asked':
      return 'waiting';
    case 'turn/end':
      return turnEndState(String(data?.reason?.kind ?? ''));
    default:
      return null;
  }
}

/** 任务详情：取最后一个 in_progress，没有则第一个 pending；按码点截断。 */
export function taskFromEvent(event) {
  const todos = Array.isArray(event?.data?.todos) ? event.data.todos : [];
  let current;
  for (const item of todos) if (item?.status === 'in_progress') current = item;
  if (!current) current = todos.find((item) => item?.status === 'pending');
  const content = String(current?.content ?? '').trim();
  if (!content) return null;
  const points = Array.from(content);
  return points.length > TASK_TEXT_MAX ? `${points.slice(0, TASK_TEXT_MAX).join('')}…` : content;
}

/**
 * 极简状态仓：只支持写段与读快照。
 * counter 单调（Date.now 与 last+1 取大），exe 用它判断「有没有新东西」。
 */
export function createStateStore(now = () => Date.now()) {
  let counter = 0;
  let lastWorkKey = null;
  const sections = new Map();
  const nextCounter = () => {
    counter = Math.max(now(), counter + 1);
    return counter;
  };
  return {
    read() {
      const out = {};
      for (const [name, entry] of sections) out[name] = { counter: entry.counter, data: entry.data };
      return { counter, sections: out, pets: {} };
    },
    writeSection(name, data) {
      const next = nextCounter();
      sections.set(name, { counter: next, data });
      return next;
    },
    sectionData(name) {
      return sections.get(name)?.data;
    },
    /** 上一条 workStatus 的去重键：不进 /state（只在插件内用）。 */
    get lastWorkKey() {
      return lastWorkKey;
    },
    set lastWorkKey(value) {
      lastWorkKey = value;
    },
  };
}

function descriptorPath(dir) {
  return join(dir, BRIDGE_DESCRIPTOR_FILE);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** 原子写描述文件（同一个进程内重复公布只覆盖内容）。 */
export function writeBridgeDescriptor(dir, descriptor, fs = { mkdirSync, writeFileSync, renameSync, rmSync }) {
  const origin = normalizeBridgeOrigin(descriptor?.origin);
  if (origin === undefined) return false;
  const payload = {
    version: BRIDGE_DESCRIPTOR_VERSION,
    origin,
    pid: descriptor.pid,
    startedAt: descriptor.startedAt,
  };
  fs.mkdirSync(dir, { recursive: true });
  const target = descriptorPath(dir);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`);
  fs.renameSync(tmp, target);
  return true;
}

/** 只删自己写的描述文件（pid 变了说明是另一个进程的，别动）。 */
export function removeBridgeDescriptor(dir, pid, fs = { renameSync, rmSync }) {
  const current = readJson(descriptorPath(dir));
  if (current?.pid !== pid) return false;
  fs.rmSync(descriptorPath(dir), { force: true });
  return true;
}

/** 读宿主入口：优先描述文件，其次从 DSH 日志尾部认回环地址（宿主刚起、还没写文件时）。 */
export function readBridgeOrigin(dir, logsDir) {
  const descriptor = readJson(descriptorPath(dir));
  const fromFile = normalizeBridgeOrigin(descriptor?.origin);
  if (fromFile !== undefined) return fromFile;
  return originFromLogTail(logsDir);
}

/** 日志兜底：`dsh web: http://127.0.0.1:<port>/?token=…` 取最后一条。 */
export function originFromLogTail(logsDir, tailBytes = 512 * 1024) {
  try {
    const names = readdirSync(logsDir).filter((name) => /^desktop-next.*\.(?:log|jsonl)$/.test(name));
    let newest;
    let newestAt = -1;
    for (const name of names) {
      const file = join(logsDir, name);
      const at = statSync(file).mtimeMs;
      if (at > newestAt) {
        newestAt = at;
        newest = file;
      }
    }
    if (newest === undefined) return undefined;
    const size = statSync(newest).size;
    const start = Math.max(0, size - tailBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const fd = openSync(newest, 'r');
    try {
      readSync(fd, buffer, 0, length, start);
    } finally {
      closeSync(fd);
    }
    const text = buffer.toString('utf8');
    const matches = [...text.matchAll(/dsh web:\s*(https?:\/\/[^\s]+)/g)];
    const last = matches[matches.length - 1];
    return last === undefined ? undefined : normalizeBridgeOrigin(last[1]);
  } catch {
    return undefined;
  }
}

/** 宿主入口的读取面：宿主侧 webServer 的 getOrigin 会抛（listen 之前），这里统一成 undefined。 */
function hostOrigin(webServer) {
  if (!webServer || typeof webServer.getOrigin !== 'function') return undefined;
  try {
    return normalizeBridgeOrigin(webServer.getOrigin());
  } catch {
    return undefined;
  }
}

/**
 * 轮询 /state 的处理函数：GET `${ROUTE_SEGMENT}/state` → 200 JSON 信封；其余 404。
 * 单独导出便于测试（不需要真起 HTTP）。
 */
export function createStateHandler(read, routeSegment = ROUTE_SEGMENT) {
  return (req, res) => {
    const url = String(req?.url ?? '');
    if (req?.method !== 'GET' || url.split('?')[0] !== `${routeSegment}/state`) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'not-found' }));
      return;
    }
    const body = JSON.stringify(read());
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };
}

/**
 * 把会话事件压进状态仓：workStatus（去重）+ notify（回合结果）。
 * @returns 是否写了 workStatus（测试用）。
 */
export function applySessionEvent(store, session, event, now = () => Date.now()) {
  const sessionId = session?.id ?? session?.sessionId ?? null;
  const state = reduceWorkStatus(event);
  let wrote = false;
  if (state !== null) {
    const task = state === 'working' || state === 'result' ? taskFromEvent(event) : null;
    const external = sessionId === EXTERNAL_WORK_SESSION ? null : sessionId;
    const key = `${state}\u0000${task ?? ''}\u0000${external ?? ''}`;
    if (store.lastWorkKey !== key) {
      store.lastWorkKey = key;
      store.writeSection('workStatus', { state, task, sessionId: external });
      wrote = true;
    }
  }
  if (event?.type === 'turn/end') {
    const ok = state === 'success';
    store.writeSection('notify', { kind: 'turn-end', ok, state, sessionId: sessionId === EXTERNAL_WORK_SESSION ? null : sessionId, at: now() });
  }
  return wrote;
}

/**
 * 插件入口。
 * @param {object} ctx - DSH 宿主上下文（只需要 webServer、on、effect）。
 */
export function apply(ctx) {
  const log = (message) => {
    const logger = ctx?.logger;
    if (logger && typeof logger.info === 'function') logger.info(message);
    else console.log(message);
  };

  const store = createStateStore();
  const dir = bridgeDir();
  const pid = process.pid;
  const startedAt = Date.now();

  // 1) 本机 state 路由：exe 每秒拉一次。
  if (typeof ctx.effect === 'function' && typeof ctx.webServer?.register === 'function') {
    ctx.effect(() =>
      ctx.webServer.register({ kind: 'prefix', path: ROUTE_SEGMENT, handler: createStateHandler(() => store.read()) }),
    );
  } else {
    log('[dsh-pet-bridge] 没有 webServer：本插件只做数据通道，缺它就什么都不做');
    return;
  }

  // 2) 会话事件 → workStatus / notify。
  if (typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('session/event', (session, event) => applySessionEvent(store, session, event)));
  }

  // 3) 公布宿主入口（webServer 可能还没 listen，getOrigin 会抛：短周期重试）。
  let attempts = 0;
  let timer;
  const announce = () => {
    const origin = hostOrigin(ctx.webServer);
    if (origin === undefined) {
      attempts += 1;
      if (attempts >= ANNOUNCE_MAX_ATTEMPTS) {
        log(`[dsh-pet-bridge] 公布入口失败：重试 ${attempts} 次仍取不到 WebServer 入口（桌面桌宠会退化成独立模式）`);
        return;
      }
      timer = setTimeout(announce, ANNOUNCE_RETRY_MS);
      timer.unref?.();
      return;
    }
    try {
      writeBridgeDescriptor(dir, { origin, pid, startedAt });
      log(`[dsh-pet-bridge] 宿主入口已公布：${origin}（桌面桌宠会发现并接入会话工作状态）`);
    } catch (error) {
      log(`[dsh-pet-bridge] 写描述文件失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      if (timer !== undefined) clearTimeout(timer);
      try {
        removeBridgeDescriptor(dir, pid);
      } catch {
        /* 卸载时删不掉也无所谓：exe 会按连续失败判定断开 */
      }
    });
  }
  announce();
}

export const name = 'pet';
export const inject = ['webServer'];
