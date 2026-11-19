# dsh-pet-bridge

DSH（DeepSeek Harness）侧的**纯数据通道**插件，配合桌面版桌宠 exe 使用。

## 配套仓库

| 角色 | 仓库 | 说明 |
| --- | --- | --- |
| **桌面端（主仓，exe）** | https://github.com/Justinliu123/dsh-pet | 桌宠本体：气泡/外观/余额/账本/设置页，可打包成便携 exe |
| 插件端（本仓） | https://github.com/Justinliu123/dsh-pet-bridge | 只提供 `workStatus` / `notify` 与 `/state` 读取口 |
| 上游来源（原作者） | https://github.com/PC2005-cloud/dsh-pet | 桌面端 fork 的上游项目，本仓的协议按它的 `PollStateStore` 信封对齐 |

## 它做什么

| 能力 | 说明 |
| --- | --- |
| 会话工作状态 | 监听 `session/event`，压成 `{state, task, sessionId}` 写进 `workStatus` 段 |
| 回合通知 | `turn/end` 时写 `notify` 段（`{kind:'turn-end', ok, state, sessionId, at}`） |
| 本机读取口 | `GET /dsh-pet-7340/state`（loopback，无鉴权，只读） |
| 入口公布 | 把宿主 origin 写进 `<APPDATA>\dsh-pet\bridge\standalone-bridge.json`，桌面 exe 每秒读它 |

## 它不做什么（边界＝单一写者）

- **不读配置、不写配置**：桌宠配置与 AI 设置只有 exe 那一份（`<exe>\data\`）。
- **不查余额、不记账**：`balance` 段与 `spend.json` 归 exe 自己。
- **没有界面**：不声明 `dsh.client`，不画 DSH 页面内宠物，也不拉桌面 Helper。

这样主仓（exe）与插件仓可以各自发版：插件升级不影响桌宠功能，桌宠升级也不需要重装插件。

## 安装

```powershell
# 放进 DSH profile 的 node_modules（与主仓 exe 同一台机器）
$profile = "D:\deepseek\profiles\desktop"       # 你的 DSH 数据根 + \profiles\desktop
Remove-Item -Recurse -Force "$profile\node_modules\dsh-pet"
Copy-Item -Recurse . "$profile\node_modules\dsh-pet"
```

然后在 DSH 里启用插件（或手工在 `cordis.patch.yml` 里加 `- { id: dsh-pet, disabled: false }`），**重启一次 DSH**。

## 验证

1. 桌宠 exe 日志（`<exe>\data\logs.txt`）出现 `DSH 桥已连接：http://127.0.0.1:<port>`；
2. 目录 `%APPDATA%\dsh-pet\bridge\standalone-bridge.json` 存在且 `origin` 与 DSH 当前端口一致；
3. DSH 里跑一个回合，桌宠的工作状态动画跟着变；回合结束有通知气泡。

## 开发

```bash
node --test test/index.test.mjs   # 10 个用例，纯函数 + 假 ctx 冒烟
```

无构建步骤：`lib/index.js` 就是发布产物（纯 ESM，无运行时依赖）。

## 协议

`GET /dsh-pet-7340/state` 返回与主仓同构的信封：

```json
{
  "counter": 1001,
  "sections": {
    "workStatus": { "counter": 1000, "data": { "state": "working", "task": "改桥", "sessionId": "s-1" } },
    "notify": { "counter": 1001, "data": { "kind": "turn-end", "ok": true, "state": "success", "sessionId": "s-1", "at": 1795090000000 } }
  },
  "pets": {}
}
```

`counter` 单调递增，消费方据此判断「有没有新内容」。
