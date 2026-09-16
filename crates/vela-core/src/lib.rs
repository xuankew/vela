//! Vela 的框架无关内核。
//!
//! **不依赖 Tauri。** 这不是洁癖：内核一旦 import 了 Tauri，单元测试就要起 `AppHandle`、
//! CLI 工具没法复用、将来加个 headless 的批量转换工具就得重写一遍。Tauri command 只是
//! 它外面薄薄一层适配器，住在 `src-tauri/` 里。
//!
//! 模块划分见 PLAN.md §2.5。已落地：`fs`（M1-B）、`session`（M1-F）。
//! 其余模块等真正用到时再加，不预先建一堆空目录当装饰。

pub mod fs;
pub mod session;
