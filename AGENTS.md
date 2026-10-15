# 插件维护约定

- 本仓库是 DSH Godot Control 的唯一修改入口。修复必须先在这里实现并验证，再同步到游戏工程；禁止直接修改目标工程 `addons/dsh_godot/` 内的插件代码。
- `tpr/godot-ai/` 保留固定上游源码，不直接修改。`godot/plugin.gd`、`godot/resource_reimport.gd` 和 `scripts/build-addon.mjs` 是适配输入；`godot/addons/dsh_godot/` 与 `commands.json` 是生成产物。修改输入后运行 `npm run build`，提交输入及对应产物，避免下次生成覆盖补丁。
- 使用 `node scripts/install-addon.mjs --project <工程根目录>` 同步仓库产物；需要写入当前 DSH 配对时加 `--pair`。使用 `--check` 核对全部插件文件的 SHA-256。Godot 自动生成的 `.uid` 不参与代码一致性检查。
- Godot 连接配置保存在各项目 `.godot/dsh-godot-control/connection.cfg`，不进入 Git、发布包或验证报告。兼容读取旧编辑器配置，仅在没有项目配置时回退。不要打印真实 token。
- 资源刷新按扫描、等待完成、必要时强制重导入、重新运行游戏的顺序处理。`reload_plugin` 重载插件本身，不等同于重建资源缓存。没有证据时不要宣称必须重启编辑器。
- 完成修改后运行 `npm run check`、`npm test` 和隔离的 `npm run test:native`；资源导入验收必须检查实际材质，不能只检查返回的资源计数。
