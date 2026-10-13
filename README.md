# DSH Godot Control

让 DSH 直接操作 Godot 编辑器。DSH 插件提供原生工具与本机 WebSocket 服务，Godot 插件执行编辑器命令；运行时使用 DSH 自带 Node.js 和 Godot，不需要 Python、MCP 服务或另外启动的桥接进程。

目标环境：HarmonyOS PC ARM64、DSH 0.2.0-rc.2、Godot 4.7 及更新的 4.x。编辑器操作基于 Godot AI v4.3.0；验证范围见 [VERIFICATION.md](VERIFICATION.md)，第三方输入见 [THIRD_PARTY.md](THIRD_PARTY.md)。

## 安装与配对

1. 下载并解压 [Release](https://github.com/oheco/dsh-godot-control/releases/latest) 中的 ZIP。DSH 插件管理页选择“从本地目录安装”，选择含 `package.json` 的外层目录，启用 `@oheco/dsh-godot-control`。
2. 将包内 `godot/addons/dsh_godot` 目录复制到 Godot 项目的 `addons` 中，在“项目设置 → 插件”启用 **DSH Godot Control**。这个 addon 与原版 Godot AI 使用不同目录和类名。
3. 打开 DSH 插件详情的“Godot 配对”面板，复制连接令牌。地址中的端口默认为 `9500`；令牌仅在点击显示或复制时读取。
4. 在 Godot 的 **DSH Godot** 面板填写端口与令牌，点击“保存配对并连接”。回到 DSH 刷新状态，显示项目路径即完成配对。

配对在编辑器的私有配置目录中持久化，不写入项目、EditorSettings 或发行包。Godot 断线后自动重连；DSH 关闭或卸载插件会释放监听端口并结束待处理调用。目录安装可能持续引用原目录，请保留安装目录。端口冲突会在 DSH 插件加载时明确报错，可同时修改 DSH 保存配置和 Godot 配对端口。

## 使用

可以直接对 DSH 说：“读取当前 Godot 场景，在 Main 下创建一个 Player 节点，将位置改成 1、2、3，然后保存场景。”

| 工具 | 用途 |
| --- | --- |
| `godot_status` | 连接状态、项目、会话 ID 与就绪状态 |
| `godot_commands` | 查询命令、领域、参数提示和执行条件 |
| `godot_scene_tree` | 当前场景树，支持深度和分页 |
| `godot_scene` | 创建、打开、保存场景与节点查找 |
| `godot_node` | 节点创建、属性、层级、分组与选择 |
| `godot_script` | 脚本读写、修改与挂载 |
| `godot_project` | 项目设置、运行与停止游戏 |
| `godot_editor` | 编辑器状态、日志、截图和调试 |
| `godot_command` | 资源、材质、动画、UI、物理、音频等其他命令 |

命令列表由上游编辑器注册表生成，共 161 项。使用插件命令名，例如 `create_node`，参数位于 `params`。`godot_commands` 提供字段提示；具体命令的完整语义沿用上游 GDScript handler。多个编辑器同时连接时，调用必须传入 `godot_status` 返回的 `session_id`。

例如调用 `godot_node`：

```json
{
  "command": "set_property",
  "params": {
    "path": "/Main/Player",
    "property": "position",
    "value": {"x": 1, "y": 2, "z": 3}
  }
}
```

场景修改保留 Godot 撤销记录；保存场景和文件写入直接持久化。修改前会读取编辑器的当前就绪状态；导入中拒绝修改，运行中仅允许适用的运行控制命令。超时、取消或断线不会自动重放操作，已经执行的编辑器操作也不会因取消而回滚，请先检查状态再决定重试。

## 协议与开发

连接仅监听 `127.0.0.1`，使用 Godot AI 协议 2 的四步双向 HMAC-SHA256 认证。项目元数据在 Godot 验证服务端证明后发送，请求响应通过 `request_id` 匹配到原连接。握手期限为 5 秒，握手消息上限 8 KiB，普通消息上限 4 MiB，编辑器最多 32 个。接收缓冲在认证前也可能接收一个 4 MiB WebSocket 消息，8 KiB 是握手解析限制。凭据不进入工具状态或模型上下文。

依赖源码已固定并随包提供，检查与构建不下载依赖：

```sh
npm run build
npm run check
npm test
npm run test:native
npm run package
```

`GODOT_BIN` 可指定验证用编辑器；真实测试使用 `$TMPDIR` 下独立项目，日志与报告写入 `$XDG_CACHE_HOME/dsh-godot-control/verification/`。`DSH_GODOT_ALLOW_HEADLESS=1`、`DSH_GODOT_WS_PORT` 和 `DSH_GODOT_TOKEN` 供隔离验收使用。普通用户在面板中配对。

卸载时先在 DSH 中移除 bundle，再关闭 Godot 项目中的插件并移除 addon。配对配置默认保留，方便重装。
