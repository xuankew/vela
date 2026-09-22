//! Vela 的框架无关内核。
//!
//! **不依赖 Tauri。** 这不是洁癖：内核一旦 import 了 Tauri，单元测试就要起 `AppHandle`、
//! CLI 工具没法复用、将来加个 headless 的批量转换工具就得重写一遍。Tauri command 只是
//! 它外面薄薄一层适配器，住在 `src-tauri/` 里。
//!
//! 模块划分见 PLAN.md §2.5。已落地：`fs`（M1-B）、`session`（M1-F）、`project`（M2-A/M2-B/M2-E）、
//! `search`（M2-C/M2-D）、`watcher`（M2-G）、`settings`（M4-A 分层配置）。其余模块等真正用到时再加，
//! 不预先建一堆空目录当装饰。
//!
//! ⚠️ `watcher` 是个**例外**：它名字底下那件事（起一个 `notify` 的 watcher）压根不在这里，
//! 在 `src-tauri` 里。这一层只留「该盯哪些目录」、「两份计划之间要动哪些订阅」与
//! 「一条事件算哪一种变化」三件能同步跑完的事，理由写在 `watcher/mod.rs` 开头。
//!
//! ## 测试名是一句中文，而且**不能含大写 ASCII**
//!
//! `cargo clippy --workspace --all-targets -- -D warnings` 里那条 `-D warnings` 把
//! `non_snake_case` 也变成了硬错误，于是 `fn 含_NUL_的文件…` 编译不过。
//! 别照着 clippy 的建议把它小写成 `含_nul_的…`——那比原名更难读。
//! 正确做法是把缩写换成中文：`NUL` → `空字符`、`UTF-16 码元` → `码元`、
//! `UTF8`/`ASCII` → `纯文本编码`/`英文`。小写 ASCII 词（`literal`、`rel`）不受影响。

pub mod fs;
pub mod keybindings;
pub mod project;
pub mod search;
pub mod session;
pub mod settings;
pub mod watcher;
