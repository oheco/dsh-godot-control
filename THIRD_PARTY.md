# 固定的第三方输入

`tpr/godot-ai/` 保留 [hi-godot/godot-ai](https://github.com/hi-godot/godot-ai) 的完整源码，基线 v4.3.0，提交 `b82b5c519b1b17228f70d8effce1626f391bd1dd`，MIT 许可证保留在该目录。生成脚本从其中的 GDScript addon 派生 `godot/addons/dsh_godot/`，替换插件启动入口、使用独立类名与目录、调整运行时消息命名，并将 WebSocket 的启动方式标为 dsh。Python 源码作为上游审计输入保留，运行插件不导入或执行它。0.1.1 在生成阶段统一两端 `CAPTURE_PREFIX`，将资源重导入替换为本仓库的 `godot/resource_reimport.gd` 实现，并在插件模板中增加项目配对配置及自动重连。固定的上游目录不作修改。

`tpr/ws/` 是 ws 8.21.0 完整 JavaScript 发行源码，来源 [websockets/ws](https://github.com/websockets/ws)，MIT 许可证保留。官方归档 https://registry.npmjs.org/ws/-/ws-8.21.0.tgz ，SHA-256 `d08b726b3aae3a0fed5218a0d9a4b2ac8d75d4ad453a9271db55fe38e94eb4cf`。采用其 JavaScript 实现，无须 bufferutil 或 utf-8-validate 原生 addon。

`tpr/fflate/` 保留 fflate 0.8.2 的 JavaScript 发行文件及 `source/` 中的完整 TypeScript 源码，MIT 许可证保留。归档地址、大小、SHA-256 及三项依赖的完整源码归档记录在 [dependencies.json](dependencies.json)。发行包仅用这个纯 JavaScript 实现生成 ZIP。

DSH 入口、按 Agent 注册工具、配对面板和 bundle 布局参考 [oheco/dsh-browser-control](https://github.com/oheco/dsh-browser-control) 0.1.1 的 MIT 实现。发行构建保留逐文件源码 SHA-256 清单。
