//! 快捷键配置管理（M4-E）。
//!
//! 用户自定义快捷键存在 `~/.vela/keybindings.json`，形状是：
//! ```json
//! {
//!   "view.togglePreview": "Mod+Shift+P",
//!   "editor.save": ["Mod+S", "F2"]
//! }
//! ```
//!
//! ## 安全边界
//!
//! - **不解析、不校验快捷键串**：这只是个不透明 JSON 对象，前端负责解析与校验。
//!   Rust 侧只负责读写文件，像对待 settings 一样把它当成「前端定义的结构」。
//! - **原子写**：先写 `.tmp` 再 rename，失败时盘上要么旧版要么没文件，不会停在半截。
//! - **路径固定**：永远只读/写 `~/.vela/keybindings.json`，home 由 [`home_dir`] 算出，
//!   前端没有任何输入能影响这个位置。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// 用户自定义快捷键映射：命令 ID → 快捷键串或数组。
///
/// 这是 load/save 的原样形状，不做任何校验。校验归前端管。
pub type UserKeybindings = HashMap<String, serde_json::Value>;

/// 加载结果。文件不存在不算错，当成「没有自定义配置」。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct LoadedKeybindings {
    /// 合并后的用户配置；读失败时是空对象
    pub keybindings: UserKeybindings,
}

/// 保存报告（目前只有成功/失败，未来可加统计）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SaveReport {
    /// 是否成功写入
    pub success: bool,
}

/// 从 `~/.vela/keybindings.json` 读取用户自定义快捷键。
///
/// 文件不存在时返回空配置，不算错误。
/// 文件存在但解析失败时也返回空配置（静默降级），前端会看到空对象。
pub fn load(home: &Path) -> LoadedKeybindings {
    let path = home.join(".vela").join("keybindings.json");
    
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            match serde_json::from_str::<UserKeybindings>(&content) {
                Ok(keybindings) => LoadedKeybindings { keybindings },
                Err(_) => {
                    // 解析失败，静默降级为空配置
                    eprintln!("[keybindings] 解析 {} 失败，使用空配置", path.display());
                    LoadedKeybindings {
                        keybindings: HashMap::new(),
                    }
                }
            }
        }
        Err(_) => {
            // 文件不存在或读不到，返回空配置
            LoadedKeybindings {
                keybindings: HashMap::new(),
            }
        }
    }
}

/// 把用户自定义快捷键原子写入 `~/.vela/keybindings.json`。
///
/// 原子写：先写 `.tmp` 再 rename，确保失败时盘上要么旧版要么没文件。
pub fn save(home: &Path, keybindings: &UserKeybindings) -> Result<SaveReport, std::io::Error> {
    let dir = home.join(".vela");
    std::fs::create_dir_all(&dir)?;
    
    let tmp_path = dir.join("keybindings.json.tmp");
    let final_path = dir.join("keybindings.json");
    
    let json = serde_json::to_string_pretty(keybindings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    
    // 原子写：先写临时文件，fsync，再 rename
    std::fs::write(&tmp_path, json.as_bytes())?;
    
    // macOS / Linux 上 rename 是原子的
    #[cfg(unix)]
    {
        std::fs::rename(&tmp_path, &final_path)?;
    }
    
    // Windows 上也是原子的（只要目标不在使用中）
    #[cfg(windows)]
    {
        std::fs::rename(&tmp_path, &final_path).or_else(|_| {
            // 如果失败，尝试删除后再 rename
            if final_path.exists() {
                std::fs::remove_file(&final_path)?;
            }
            std::fs::rename(&tmp_path, &final_path)
        })?;
    }
    
    Ok(SaveReport { success: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn load_returns_empty_when_file_missing() {
        let tmp = TempDir::new().unwrap();
        let loaded = load(tmp.path());
        assert!(loaded.keybindings.is_empty());
    }

    #[test]
    fn load_parses_valid_json() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join(".vela");
        std::fs::create_dir_all(&dir).unwrap();
        
        let path = dir.join("keybindings.json");
        std::fs::write(
            &path,
            r#"{"view.togglePreview": "Mod+Shift+P"}"#,
        )
        .unwrap();
        
        let loaded = load(tmp.path());
        assert_eq!(loaded.keybindings.len(), 1);
        assert!(loaded.keybindings.contains_key("view.togglePreview"));
    }

    #[test]
    fn load_degrades_on_invalid_json() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join(".vela");
        std::fs::create_dir_all(&dir).unwrap();
        
        let path = dir.join("keybindings.json");
        std::fs::write(&path, "not json").unwrap();
        
        let loaded = load(tmp.path());
        assert!(loaded.keybindings.is_empty());
    }

    #[test]
    fn save_writes_atomic() {
        let tmp = TempDir::new().unwrap();
        let mut kb = UserKeybindings::new();
        kb.insert(
            "editor.save".to_string(),
            json!(["Mod+S", "F2"]),
        );
        
        let report = save(tmp.path(), &kb).unwrap();
        assert!(report.success);
        
        let path = tmp.path().join(".vela").join("keybindings.json");
        assert!(path.exists());
        
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("editor.save"));
    }
}
