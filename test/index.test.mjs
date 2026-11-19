import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ANNOUNCE_RETRY_MS,
  BRIDGE_DESCRIPTOR_FILE,
  ROUTE_SEGMENT,
  apply,
  applySessionEvent,
  bridgeDir,
  createStateHandler,
  createStateStore,
  normalizeBridgeOrigin,
  originFromLogTail,
  reduceWorkStatus,
  removeBridgeDescriptor,
  taskFromEvent,
  writeBridgeDescriptor,
} from '../lib/index.js';

test('normalizeBridgeOrigin：只放行 http(s)，并归一化成 origin', () => {
  assert.equal(normalizeBridgeOrigin('http://127.0.0.1:51234/?token=abc'), 'http://127.0.0.1:51234');
  assert.equal(normalizeBridgeOrigin('https://example.com/path'), 'https://example.com');
  assert.equal(normalizeBridgeOrigin('file:///c:/x'), undefined);
  assert.equal(normalizeBridgeOrigin('not a url'), undefined);
  assert.equal(normalizeBridgeOrigin(undefined), undefined);
});

test('reduceWorkStatus：会话事件 → 档位（与主仓一致）', () => {
  assert.equal(reduceWorkStatus({ type: 'turn/start' }), 'thinking');
  assert.equal(reduceWorkStatus({ type: 'tool/call', data: { name: 'read' } }), 'working');
  assert.equal(reduceWorkStatus({ type: 'tool/call', data: { name: 'ask_user_question' } }), 'waiting');
  assert.equal(reduceWorkStatus({ type: 'tool/result' }), 'result');
  assert.equal(reduceWorkStatus({ type: 'approval/asked' }), 'waiting');
  assert.equal(reduceWorkStatus({ type: 'turn/end', data: { reason: { kind: 'completed' } } }), 'success');
  assert.equal(reduceWorkStatus({ type: 'turn/end', data: { reason: { kind: 'error' } } }), 'error');
  assert.equal(reduceWorkStatus({ type: 'turn/end', data: { reason: { kind: 'aborted' } } }), null);
  assert.equal(reduceWorkStatus({ type: 'todo/write', data: {} }), null);
});

test('taskFromEvent：取最后一个 in_progress，按码点截断', () => {
  assert.equal(taskFromEvent({ data: { todos: [{ status: 'completed', content: 'a' }] } }), null);
  assert.equal(
    taskFromEvent({ data: { todos: [{ status: 'pending', content: '下一步' }, { status: 'in_progress', content: '正在做' }] } }),
    '正在做',
  );
  const long = '一二三四五六七八九十'.repeat(6);
  const text = taskFromEvent({ data: { todos: [{ status: 'in_progress', content: long }] } });
  assert.equal(Array.from(text).length, 41); // 40 个码点 + 省略号
  assert.ok(text.endsWith('…'));
});

test('createStateStore：counter 单调、信封形状与主仓一致', () => {
  let now = 1000;
  const store = createStateStore(() => now);
  store.writeSection('workStatus', { state: 'thinking', task: null, sessionId: 's1' });
  now = 1000; // 同一毫秒内再写：counter 仍要递增
  store.writeSection('notify', { kind: 'turn-end' });
  const snapshot = store.read();
  assert.equal(snapshot.counter, 1001); // 同一毫秒内两次写：第二次仍 +1
  assert.deepEqual(Object.keys(snapshot.sections).sort(), ['notify', 'workStatus']);
  assert.equal(snapshot.sections.workStatus.counter, 1000);
  assert.equal(snapshot.sections.notify.counter, 1001);
  assert.deepEqual(snapshot.pets, {});
});

test('applySessionEvent：workStatus 去重、外部槽 sessionId 归一成 null、回合结束写 notify', () => {
  const store = createStateStore();
  assert.equal(applySessionEvent(store, { id: 's1' }, { type: 'turn/start' }, () => 5), true);
  assert.deepEqual(store.sectionData('workStatus'), { state: 'thinking', task: null, sessionId: 's1' });
  // 同一状态再来一次：不重复写
  assert.equal(applySessionEvent(store, { id: 's1' }, { type: 'turn/start' }, () => 6), false);
  // 外部槽
  applySessionEvent(store, { id: 'api' }, { type: 'tool/call', data: { name: 'x' } }, () => 7);
  assert.equal(store.sectionData('workStatus').sessionId, null);
  // 回合结束 → notify
  applySessionEvent(store, { id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }, () => 8);
  assert.deepEqual(store.sectionData('notify'), { kind: 'turn-end', ok: true, state: 'success', sessionId: 's1', at: 8 });
  applySessionEvent(store, { id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } }, () => 9);
  assert.equal(store.sectionData('notify').ok, false);
});

test('描述文件：写入带 origin/pid、只删自己的', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-bridge-desc-'));
  try {
    assert.equal(writeBridgeDescriptor(dir, { origin: 'http://127.0.0.1:53522/', pid: 4321, startedAt: 99 }), true);
    const raw = JSON.parse(readFileSync(join(dir, BRIDGE_DESCRIPTOR_FILE), 'utf8'));
    assert.deepEqual(raw, { version: 1, origin: 'http://127.0.0.1:53522', pid: 4321, startedAt: 99 });
    assert.equal(removeBridgeDescriptor(dir, 9999), false); // 别人的
    assert.equal(removeBridgeDescriptor(dir, 4321), true);
    assert.equal(removeBridgeDescriptor(dir, 4321), false); // 已经没了
    assert.equal(writeBridgeDescriptor(dir, { origin: 'file:///x', pid: 1, startedAt: 1 }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('state 路由：GET /state 返回信封，其余 404', () => {
  const store = createStateStore();
  store.writeSection('workStatus', { state: 'working', task: '改桥', sessionId: 's1' });
  const handler = createStateHandler(() => store.read());
  const reply = (req) => {
    const out = { status: 0, headers: {}, body: '' };
    handler(req, {
      writeHead(status, headers) {
        out.status = status;
        out.headers = headers;
      },
      end(body) {
        out.body = body;
      },
    });
    return out;
  };
  const ok = reply({ method: 'GET', url: `${ROUTE_SEGMENT}/state` });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).sections.workStatus.data.state, 'working');
  assert.equal(reply({ method: 'GET', url: `${ROUTE_SEGMENT}/state?x=1` }).status, 200);
  assert.equal(reply({ method: 'POST', url: `${ROUTE_SEGMENT}/state` }).status, 404);
  assert.equal(reply({ method: 'GET', url: '/other' }).status, 404);
});

test('日志兜底：从 desktop-next*.log 尾部取最后一次 dsh web 入口', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-bridge-log-'));
  try {
    writeFileSync(join(dir, 'desktop-next.log'), '[info] dsh web: http://127.0.0.1:1111/?token=a\n');
    writeFileSync(join(dir, 'desktop-next-2026-11-19.1.jsonl'), '{"msg":"dsh web: http://127.0.0.1:2222/?token=b"}\n');
    // Windows 的 mtime 精度只有 100ns 级但同毫秒会相等：显式拉开，让「最新日志」判定稳定
    utimesSync(join(dir, 'desktop-next.log'), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    utimesSync(join(dir, 'desktop-next-2026-11-19.1.jsonl'), new Date(1_700_000_100_000), new Date(1_700_000_100_000));
    assert.equal(originFromLogTail(dir), 'http://127.0.0.1:2222');
    rmSync(join(dir, 'desktop-next-2026-11-19.1.jsonl'));
    assert.equal(originFromLogTail(dir), 'http://127.0.0.1:1111');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply：webServer 尚未 listen 时重试，拿到入口后写描述文件；卸载时删掉', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-bridge-apply-'));
  const prevAppData = process.env.APPDATA;
  process.env.APPDATA = dir; // bridgeDir() = <dir>/dsh-pet/bridge
  mkdirSync(join(dir, 'dsh-pet', 'bridge'), { recursive: true });
  const cleanups = [];
  let registered;
  let originCalls = 0;
  const ctx = {
    webServer: {
      // 前两次「还没 listen」：抛错 → 插件应重试
      getOrigin() {
        originCalls += 1;
        if (originCalls <= 2) throw new Error('not listening');
        return 'http://127.0.0.1:54000/';
      },
      register(spec) {
        registered = spec;
        return () => {};
      },
    },
    on() {
      return () => {};
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') cleanups.push(dispose);
    },
    logger: { info() {} },
  };
  try {
    apply(ctx);
    await new Promise((resolve) => setTimeout(resolve, ANNOUNCE_RETRY_MS * 4));
    assert.equal(registered.path, ROUTE_SEGMENT);
    const descriptor = JSON.parse(readFileSync(join(dir, 'dsh-pet', 'bridge', BRIDGE_DESCRIPTOR_FILE), 'utf8'));
    assert.equal(descriptor.origin, 'http://127.0.0.1:54000');
    assert.equal(descriptor.pid, process.pid);
    for (const dispose of cleanups.reverse()) dispose();
    let gone = false;
    try {
      readFileSync(join(dir, 'dsh-pet', 'bridge', BRIDGE_DESCRIPTOR_FILE), 'utf8');
    } catch {
      gone = true;
    }
    assert.equal(gone, true);
  } finally {
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bridgeDir：Windows 用 APPDATA，否则回落 ~/.config', () => {
  assert.equal(bridgeDir({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }), join('C:\\Users\\x\\AppData\\Roaming', 'dsh-pet', 'bridge'));
  assert.equal(bridgeDir({ HOME: '/home/x' }), join('/home/x', '.config', 'dsh-pet', 'bridge'));
});
