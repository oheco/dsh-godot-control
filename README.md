# DSH Godot Control

让 DSH 直接操作 Godot 编辑器。DSH 插件提供原生工具与本机 WebSocket 服务，Godot 插件执行编辑器命令；运行时使用 DSH 自带 Node.js 和 Godot，不需要 Python、MCP 服务或另外启动的桥接进程。

目标环境：HarmonyOS PC ARM64、DSH 0.2.0-rc.2（Node.js 24）、Godot 4.7 及更新的 4.x。DSH 与 Godot 需要运行在同一台设备上。验证范围见 [VERIFICATION.md](VERIFICATION.md)。

## Godot AI 版本引用

本仓库基于 [hi-godot/godot-ai](https://github.com/hi-godot/godot-ai) 的编辑器插件适配，固定引用以下基线：

| 项目 | 引用 |
| --- | --- |
| Godot AI 版本 | [v4.3.0](https://github.com/hi-godot/godot-ai/tree/v4.3.0) |
| 上游提交 | [b82b5c519b1b17228f70d8effce1626f391bd1dd](https://github.com/hi-godot/godot-ai/commit/b82b5c519b1b17228f70d8effce1626f391bd1dd) |
| WebSocket 协议 | Godot AI 协议 2 |
| 上游源码与许可证 | [tpr/godot-ai/](tpr/godot-ai/) |
| 本插件版本与分支 | 0.1.1，`ohos/0.1.0` |

Godot 侧复用上游的命令分发器、编辑器 handler 与运行时辅助代码，启动入口改为连接 DSH，并使用独立的 `dsh_godot` 目录和类名。DSH 侧是本仓库实现的原生插件，负责连接服务、认证、会话路由和工具注册。原版 Python 后端的启动、MCP 客户端配置和自动凭据发现流程由本版的 DSH 配对流程替代。

原始上游代码保留在 [tpr/godot-ai/](tpr/godot-ai/)，由 [构建脚本](scripts/build-addon.mjs)生成 [Godot addon](godot/addons/dsh_godot/)。完整依赖版本、归档地址、摘要与许可证记录见 [dependencies.json](dependencies.json) 和 [THIRD_PARTY.md](THIRD_PARTY.md)。

## 安装与配对

本插件只维护代码仓库，不通过 oheco 软件目录或 `oo` 分发。按下列步骤从仓库目录安装到 DSH；日常更新以仓库提交为准。

### 1. 获取插件代码

在要长期保留插件的目录中克隆仓库：

```sh
git -c http.proxy=socks5h://127.0.0.1:10808 clone --branch ohos/0.1.0 --single-branch https://github.com/oheco/dsh-godot-control.git
```

上述命令使用本工作区的本机 SOCKS5 代理 `127.0.0.1:10808`，其他环境请替换成自己的代理地址。仓库已包含可安装的 DSH 插件、生成好的 Godot addon 和固定依赖，安装时无需执行 `npm install` 或先运行构建。

### 2. 安装 DSH 插件

打开 DSH 插件管理页，选择“从本地目录安装”，选择刚克隆的 `dsh-godot-control` 仓库根目录，也就是 [package.json](package.json) 所在目录，然后启用 **@oheco/dsh-godot-control**。

目录安装可能持续引用原目录，请保留整个仓库目录。DSH 插件详情中会出现“Godot 配对”面板。

### 3. 安装 Godot 编辑器插件

在仓库根目录执行以下命令，将完整 addon 同步到目标工程。工程路径可以包含空格：

```sh
node scripts/install-addon.mjs --project "/path/to/my-game"
```

已在本机启用 DSH 插件时，可以添加 `--pair`，直接将当前 DSH 的端口和 token 写入项目配置，不输出 token：

```sh
node scripts/install-addon.mjs --project "/path/to/my-game" --pair
node scripts/install-addon.mjs --project "/path/to/my-game" --check
```

`--check` 核对全部插件文件的 SHA-256，忽略 Godot 自动生成的 `.uid`。安装来源、版本和摘要记录在项目 `.godot/dsh-godot-control/addon-source.json`。发现插件问题时先修改本仓库的适配输入、构建和验证，再运行此脚本同步；不要直接修改工程内的插件副本。安装后的项目结构应为：

```text
my-game/
  project.godot
  addons/
    dsh_godot/
      plugin.cfg
      plugin.gd
      ...
```

打开该项目，在“项目设置 → 插件”中启用 **DSH Godot Control**，编辑器中会出现 **DSH Godot** 面板。每个需要控制的 Godot 项目都安装一次这个 addon。

### 4. 首次配对与确认连接

1. 在 DSH 的“Godot 配对”面板查看连接地址，复制令牌。端口默认为 `9500`；令牌仅在点击显示或复制时读取。
2. 在 Godot 的 **DSH Godot** 面板填写相同端口与令牌，点击“保存配对并连接”。
3. 回到 DSH 刷新状态，确认显示该 Godot 项目路径。也可以让 DSH 调用 `godot_status` 查看连接状态，再调用 `godot_scene_tree` 读取当前场景。

Godot 端配对保存在当前项目的 `.godot/dsh-godot-control/connection.cfg`，每个项目可以设置不同的服务端口和 token。插件每秒检查配置内容变化，外部工具或 AI 写入后会自动重新连接，无需重启编辑器。项目配置不强制要求 POSIX 权限，适用于鸿蒙共享目录。删除整个 `.godot` 后需要重新写入配对。

配置格式如下，`token` 替换为 DSH 配对面板提供的 64 位小写十六进制值：

```ini
[connection]
port=9500
token="<DSH 配对 token>"
```

读取顺序为：显式环境变量 `DSH_GODOT_TOKEN` / `DSH_GODOT_WS_PORT`、项目配置、旧版编辑器私有配置。旧配置仅在项目配置不存在时回退；已有项目配置无效时保持未连接，避免误连到其他服务。面板保存只写当前项目，不修改旧全局配置。DSH 服务端仍在自己的应用配置目录中保存一份连接信息，同一服务的多个项目使用该服务的 token。

配对文件不进入 Git、导出包或本插件发行包，也不写入 EditorSettings。DSH 关闭或卸载插件会释放监听端口并结束待处理调用。端口冲突会在 DSH 插件加载时明确报错，可同时修改 DSH 保存配置和 Godot 项目配对端口。

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

## 资源刷新与插件重载

外部批量写入模型后，调用 `scan_filesystem` 并确认 `scan_completed=true`，再运行游戏。模型曾在缺少贴图时导入、或需要重建已有导入缓存时，调用 `reimport` 并传入资源 `paths`。它会在主线程执行真正的 `EditorFileSystem.reimport_files()`，完成后才返回。

`reimported` 只包含导入有效且声明的生成文件存在的资源；`failed`、`not_found`、`skipped_non_imported` 分别列出失败、缺失和不走导入流程的路径。`all_succeeded` 表示没有失败或缺失路径，`import_completed` 表示同步导入已经结束。诊断限定为本次导入操作，不能将成功计数当成材质视觉正确的证明；需要检查贴图等具体结果。重复路径只执行一次导入。

`reload_plugin` 用于扫描后禁用、重新启用插件本身，不重启 Godot，也不替代模型强制重导入。通常按“扫描并等待 → 必要时强制重导入 → 重新运行游戏”处理资源更新。

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
