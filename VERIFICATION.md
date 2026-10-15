# 验证范围

## 0.1.1 修复验证（2026-10-15）

HarmonyOS PC ARM64 本机执行 `npm run build`、`npm run check`、`npm test` 和 `npm run test:native`，9 项自动测试、20 项真实 Godot 验收全部通过。隔离工程与缓存配置均位于 `$TMPDIR`，不读取或覆盖用户已有 Godot 配对；每次测试结束清理独立工程，报告保留在应用缓存。

新增验收实际覆盖：

- 从项目 `.godot/dsh-godot-control/connection.cfg` 完成真实双向认证；项目配置覆盖旧全局配置、无项目配置时兼容旧配置、无效项目配置阻止回退、显式环境变量覆盖。项目配置在非 0600 模式下仍可加载。
- 在同一个编辑器 PID 中，将项目配置切换到另一组端口和 token，再切回原服务，自动重连成功，不重新启动编辑器。
- 首次导入缺少外部 PNG 的 glTF，实际实例化材质确认没有贴图；补齐并扫描 PNG 后，原 glTF 材质仍无贴图；调用强制 `reimport` 后，实际材质恢复 1×1 贴图。glTF 与几何缓冲的 SHA-256、修改时间均未改变。每次材质检查绕过场景和依赖缓存。
- 混合请求中的模型实际导入一次，重复路径不重复执行；脚本归入跳过项、缺失文件归入缺失项。损坏 PNG 产生真实导入失败且不计成功，恢复后在同一编辑器内重导入成功。
- `reload_plugin` 后插件断开并重新认证，编辑器 PID 不变。
- 启动真实游戏子进程后，观察到 `helper_live=true`、`game_capture_ready=true`；通过修正后的调试通道执行 `return {"answer": 2 + 3}` 并收到 `{"answer":5}`。headless 验收工程显式为游戏子进程设置 `--headless`，不依赖编辑器自动转发该参数。
- 仓库同步支持含空格路径；校验能发现项目副本被修改；Godot 生成的 UID 不产生代码差异；配置文件叶节点为符号链接时拒绝写入，外部目标内容保持不变。

这里的资源导入成功检查是原生导入有效性及声明产物存在性，不能泛化为每套资产的所有材质视觉正确。缺贴图回归额外检查了实际材质，图形 HAP 的完整截图和音频行为不属于这次隔离 headless 验收。

## 0.1.0 初始验证

本项目在 HarmonyOS PC ARM64 上验证，Node.js 24.21.0-ohos.1，真实 Godot 为 4.7.2.stable.mono.custom_build.d5d689f3a。CLI SHA-256 为 `893b5e3f8c095bb9213d3401daed874b7926abeb5a22e27ced80799bca19373c`，对应已安装编辑器使用的构建基线。

`npm test` 的协议测试覆盖重复 JSON 键、错误密钥、协议降级、重复会话、多编辑器路由、来自其他连接的伪响应、断线、取消、导入状态拒绝修改和无效响应。

`npm run test:native` 在隔离项目运行真实 Godot，验证完整 addon 导入、GDScript 与 Node.js 的双向 HMAC 握手、场景树读取、带撤销的节点创建、Vector3 属性写入与读取、NODE_NOT_FOUND 错误码、场景保存后的文件内容、编辑器状态和日志、节点删除后的场景树。源码生成的 161 个命令不等于逐项运行全部命令；其他领域保留上游实现。

Godot 原生验证使用 headless 编辑器，不代表已验收图形 HAP 中的全部显示、截图或音频行为。Python/MCP 后端不参与这些验证。首轮冷启动超过较短的 25 秒等待窗口，后续测试将启动窗口调整为 90 秒；操作本身仍使用各调用的独立截止时间。

当前 DSH GUI `http://127.0.0.1:3080` 已实际安装、启用插件，Host 状态 active。`scripts/dsh-e2e.mjs` 创建独立会话，验证模型请求包含全部 9 个原生工具，并记录 4 次实际调用：godot_status、godot_scene_tree、godot_node/create_node、godot_scene_tree。通过 authenticated session/page 重新读取持久记录，tool/call 与 tool/result 全部按 ID 配对，isError 均为 false。独立场景查询确认 /Main/DSHVerified 是 Node3D。验收会话为 `session-eb2baa83-bafd-47fa-a41e-e2ef161718d8`；私有原始报告保留在本机缓存，不随公开包发布。

真实 Godot 扩展验证还包括脚本创建、精确内容读取、挂载后导出属性的数值，以及拒绝写入当前 addon 并确认原文件字节不变。ZIP 构建逐文件核对解压后 SHA-256；发行包需要在含空格的独立目录中执行检查、协议测试和真实 Godot 验收。正式 Release 和索引安装在发布后进行复核，结果随最终交付提供。
