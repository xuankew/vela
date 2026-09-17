//! 会话存档（PLAN.md §2.5 `session/`）：上次开着哪些文档、每个文档停在哪儿。
//!
//! ## 为什么是一个 JSON 文件，而不是 rusqlite / sled
//!
//! PLAN.md 原本写的是「rusqlite/sled」。落地时改成**单个原子写入的 JSON 文件**，
//! 因为这份数据的读写模式正好是数据库最不划算的那一种：
//!
//! - 写：关闭时一次、编辑中每隔几秒一次，**每次都是整份重写**——没有单键更新；
//! - 读：启动时一次，**整份读回来**——没有查询、没有随机访问、没有范围扫描；
//! - 量级：几十个标签，几百 KB。
//!
//! 在这种形状下，数据库带来的只有成本：rusqlite 的 `bundled` 特性要从源码编译整个
//! SQLite（约 1–2 分钟构建、产物 +1MB），sled 依赖树更大——两者都直接顶在
//! 「占用内存小、启动快」这条产品要求上。而收益是零，因为我们一个 SQL 特性都用不上。
//!
//! 还有一个不好量化的好处：会话恢复出问题时，用户可以自己打开 `session.json` 看。
//! 一个损坏的 sled 数据库是死路。
//!
//! **重估点**：出现「每个窗口一份会话」「多个具名会话」「草稿需要增量落盘而不是整份重写」
//! 中任何一条时，重新评估存储形态。前两条只是多几个文件；第三条才是真的需要数据库
//! （届时的方案是「元信息 + `drafts/<id>` 分文件」，草稿先写、元信息作为提交点，
//! 代价是要自己处理跨文件的原子性）。
//!
//! 先例：PLAN §2.6 修正 2 用同一个理由把 specta 代码生成推到了 M1-H——
//! 「这个规模下不值得」是要写下来的判断，不是随手的选择。
//!
//! ## 一条硬约束：4 MiB
//!
//! `load_session` 的返回值要整个过一遍 IPC，PLAN §2.6 修正 1 给单次 payload 定的上限
//! 是 4MB。所以 `save_session` 在超预算时**从最大的草稿开始丢**（同样的字节预算下，
//! 先扔大的能让活下来的标签数最多），并把丢掉的个数报回去让前端提示用户。
//!
//! ⚠️ **绝不能静默丢**。用户以为未保存的草稿被存下来了，下次启动发现没了——
//! 这比一开始就不存更糟。

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::fs::{write_bytes_atomic, FileFormat, WriteError};

/// 存档格式版本。`load_session` 只认这一个值。
///
/// 存在的意义是「不认识就整份作废」：没有它，将来加字段时旧文件会被解析成一半对一半错的
/// 东西，而 serde 对缺失字段是**报错**、对多余字段是**忽略**——两种行为混在一起，
/// 排查起来比直接拒绝难得多。
pub const SESSION_VERSION: u32 = 1;

/// 会话文件在 `app_data_dir()` 下的名字。
pub const SESSION_FILE_NAME: &str = "session.json";

/// 单次 IPC payload 上限，见 PLAN §2.6 修正 1。
pub const MAX_SESSION_BYTES: usize = 4 * 1024 * 1024;

/// 一份会话最多多少个标签。与前端 `src/ipc/session.ts` 的同名常量同值
/// （两边各写一份、各有一条契约测试钉住，没有代码生成）。
///
/// 前端那个是**存**的预算，这个是**读**的闸：光靠 4MiB 拦不住标签数——
/// 一个标签的元信息只有一百来字节，一份手改过但结构合法的存档能塞进几万个，
/// 而前端会照着它建几万个 CodeMirror state，启动直接卡死。
pub const MAX_SESSION_TABS: usize = 64;

/// 分屏方向。与前端 `src/doc/workspace.ts` 的 `'row' | 'column'` 一一对应，
/// 字面量由 `wire_contract.rs` 与 `src/ipc/session.test.ts` 两边钉住。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaneDirection {
    /// 左右分屏
    Row,
    /// 上下分屏
    Column,
}

/// 一个标签的现场。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTab {
    /// `None` = 未命名文档（还没落过盘）
    pub path: Option<String>,
    /// 该文档的编码/行尾。**不是 Option**：未命名文档也有一份（默认格式），
    /// 而且它跟着标签存而不是当偏好存——它是**那个文档**的属性，决定它的字节怎么写回去。
    /// 跟 `path` 绑在一起的话，用户在未命名文档上选了 GBK 又没保存，重启后这个决定就没了。
    pub format: FileFormat,
    /// 有未保存改动。恢复时要照着它把标签标脏，否则关闭确认会漏掉它
    pub dirty: bool,
    /// 解码时有字节没能映射，正文里含 U+FFFD。
    ///
    /// 必须跟着草稿一起存：这个标志的全部作用是拦住「原样保存会永久损坏原文件」，
    /// 重启后把它丢了，等于把那条警告连同它要防的事故一起删掉。
    pub lossy: bool,
    /// 未保存的正文。
    ///
    /// `Some` 的条件是「没法从磁盘读回来」：脏标签，或者未命名文档。
    /// 干净且有路径的标签留 `None`，恢复时重新读盘——Vela 关着的时候文件可能被别的
    /// 程序改过，拿存档里的旧正文覆盖上去等于悄悄回退用户的文件。
    pub draft: Option<String>,
    /// 全部选区，每项是 `(anchor, head)`。
    ///
    /// 存整个数组而不是只存一个光标位置：M1-C 把多光标做成了一等公民，
    /// 恢复时把 5 个光标变成 1 个是明显的手感倒退，而代价只是一个数组。
    pub selection: Vec<(usize, usize)>,
    /// 主选区在 `selection` 里的下标
    pub main: usize,
    pub scroll_top: f64,
    pub scroll_left: f64,
}

/// 项目树那一头的现场（M2-B-4）。
///
/// 与标签页是**两套独立的状态**：树管「磁盘上有什么」，标签管「打开了哪些文档」。
/// 关掉文件夹不动任何标签，反过来也一样。所以它在存档里也是一个独立的可选部分，
/// 而不是塞进 `SessionTab` 里的某个字段。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProject {
    /// 项目根的绝对路径。恢复时原样喂给 `list_dir`，前端不做任何路径算术
    pub root: String,
    /// 摊开着的层的 `rel`，含 `""`（根本身）。
    ///
    /// 只存 `rel` 不存 `path`：`rel` 是缓存与展开集合的键（`src/project/store.ts`
    /// 不变量 3），而且它天然不含 root，换过文件夹也不会指到别处去。
    ///
    /// 条数上限**不在这一侧**：真正要花代价的是「每条 `rel` 一次 `list_dir` 往返」，
    /// 那是前端的启动成本，由 `src/project/store.ts` 的 `MAX_RESTORED_EXPANDED` 兜住。
    /// Rust 这边管的是 4MiB 的 payload 预算，`MAX_SESSION_BYTES` 已经在管了。
    /// 两边各截一次的结果是「谁也说不清最终是多少条」，所以刻意只留一处。
    pub expanded: Vec<String>,
}

/// 一次完整的会话快照。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub version: u32,
    pub direction: PaneDirection,
    /// 聚焦的分屏在 `panes` 里的下标
    pub focused: usize,
    pub tabs: Vec<SessionTab>,
    /// 每块分屏显示哪个标签，存的是 `tabs` 的下标。
    ///
    /// 用下标而不是标签 id：id 是前端运行期递增分配的，重启后对不上；
    /// 恢复时前端会分配新 id 并把旧下标映射过去。
    ///
    /// **不允许重复**：`src/doc/workspace.ts` 的不变量 2 规定「一个标签同时只显示在一个
    /// 分屏里」。放开的话 `Tab.snapshot` 就不再是「没显示时的唯一真相」，
    /// 撤销历史与滚动位置会分叉成两份——所以这里直接拒。
    pub panes: Vec<usize>,
    /// 项目树。`None` = 上次没打开任何文件夹。
    ///
    /// ## 为什么加了它 `SESSION_VERSION` 还是 1
    ///
    /// 版本号的全部作用是「不认识就整份作废」，而这里**不存在读不懂的情形**：
    /// 读的方向上，`Raw::project` 带 `#[serde(default)]`，M1-F 时代写下的存档（没有这个
    /// key）解析成 `None`，等价于「上次没打开文件夹」——正是当时的事实；
    /// 写的方向上，serde 默认**忽略**未知字段，所以旧版 Vela 读到新存档只会当没看见。
    /// 两个方向都优雅降级，没有哪一边会得到一个半对半错的现场，于是没有作废的必要。
    ///
    /// 反过来说， bump 版本号的代价是确定的：所有 M1-F 用户重启一次就丢光会话。
    /// 为一次纯增量的可选字段付这个代价不划算。
    ///
    /// ⚠️ 这条推理只对「**新增可选字段**」成立。哪天要改已有字段的含义、要删字段、
    /// 或者要收紧 `validate`（让原本合法的存档变非法），版本号就必须动——那时
    /// 「整份作废」比「解析成一半对一半错」好排查得多，见 `SESSION_VERSION` 的文档。
    ///
    /// ## 为什么刻意**不**用 `skip_serializing_if = "Option::is_none"`
    ///
    /// 省掉的只有 `"project":null` 这十几个字节，换来的是黄金 JSON 少了一个必然出现的
    /// key。少了它，「字段名写错」这件事在契约测试里就没有对照物——而字段名写错的
    /// 失败方式恰恰是静默的（见本文件头部）。前端 `Session.project` 也因此可以写成
    /// `SessionProject | null` 而不是 `?:`，符合 `src/ipc/session.ts` 那条「可空字段
    /// 一律显式 `null`」的规矩。
    pub project: Option<SessionProject>,
}

impl<'de> Deserialize<'de> for Session {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // 手写 Deserialize 只为了一件事：把 validate 挂在解析后面。
        //
        // 会话文件是**系统边界**——它来自磁盘，可能被手改过、被旧版本写过、被磁盘错误
        // 咬过一口。下标越界不在这里拦住的话，失败方式会是前端启动时一个
        // `undefined` 崩溃，而那时候连「上次的会话没能读回来」这句提示都来不及显示。
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Raw {
            version: u32,
            direction: PaneDirection,
            focused: usize,
            tabs: Vec<SessionTab>,
            panes: Vec<usize>,
            /// 唯一一个带 `default` 的字段，也就是唯一一个**后加的**字段。
            /// M1-F 的存档里没有它，缺 key 时解析成 `None`（= 上次没打开文件夹）。
            /// 其余字段刻意不给默认值，理由见 `lossy_与_format_缺失时整份作废`。
            #[serde(default)]
            project: Option<SessionProject>,
        }

        let raw = Raw::deserialize(deserializer)?;
        let session = Session {
            version: raw.version,
            direction: raw.direction,
            focused: raw.focused,
            tabs: raw.tabs,
            panes: raw.panes,
            project: raw.project,
        };
        session.validate().map_err(serde::de::Error::custom)?;
        Ok(session)
    }
}

impl Session {
    fn validate(&self) -> Result<(), String> {
        let len = self.tabs.len();
        if len == 0 {
            return Err("会话里没有任何标签".into());
        }
        if len > MAX_SESSION_TABS {
            return Err(format!("会话有 {len} 个标签，超过上限 {MAX_SESSION_TABS}"));
        }
        if self.panes.is_empty() {
            return Err("会话里没有任何分屏".into());
        }
        if self.focused >= self.panes.len() {
            return Err(format!("focused={} 越界（只有 {} 块分屏）", self.focused, self.panes.len()));
        }
        let mut seen = vec![false; len];
        for (i, pane) in self.panes.iter().enumerate() {
            if *pane >= len {
                return Err(format!("panes[{i}]={pane} 越界（只有 {len} 个标签）"));
            }
            if seen[*pane] {
                return Err(format!("panes[{i}]={pane}：标签 {pane} 已经显示在另一块分屏里"));
            }
            seen[*pane] = true;
        }
        for (i, tab) in self.tabs.iter().enumerate() {
            if tab.selection.is_empty() {
                return Err(format!("tabs[{i}] 没有选区"));
            }
            if tab.main >= tab.selection.len() {
                return Err(format!("tabs[{i}].main={} 越界", tab.main));
            }
        }
        // 项目这一部分**只**校验一件事：root 不能是空字符串。
        //
        // 空 root 会让 `list_dir` 收到一个相对路径，那是 `bad_root`；虽然也能被兜住，
        // 但一个空的绝对路径不可能是任何一次 dialog 的返回值，它只可能来自手改或磁盘
        // 错误，属于「这份存档不可信」。
        //
        // 刻意**不**在这里检查路径形状（是不是绝对、存不存在、是不是目录）：那三种情况的
        // 正确反应是「树照常建起来，在那一行显示一句错误」，而不是「整份会话作废、
        // 连标签都不恢复」。项目文件夹被移动/删除是常态（换机器、改名、外挂盘没插），
        // 为它赔上整个会话是把两种处境混成了一种。`project/tree.rs` 的 `bad_root` /
        // `not_found` 已经走在那条行内错误的通道上，这里再判一遍只会抢在它前面。
        //
        // 同理不校验 `expanded`：里面的 `rel` 会逐条送去 `list_dir`，越界的、重复的、
        // 指向文件的，都会在那一层自己变成一句错误，不影响别的层。
        if let Some(project) = &self.project {
            if project.root.is_empty() {
                return Err("project.root 是空字符串".into());
            }
        }
        Ok(())
    }
}

/// `save_session` 的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReport {
    pub bytes_written: u64,
    /// 因为超过 4MiB 预算而被丢掉的草稿个数。**大于 0 就必须告诉用户**
    pub dropped_drafts: u32,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionError {
    Io {
        reason: String,
        message: String,
    },
    /// 路径没有目录部分，无法确定临时文件放哪
    NoParent {
        path: String,
    },
    /// 文件不是合法 JSON，或者形状对不上（下标越界之类）
    Corrupt {
        message: String,
    },
    /// `version` 不认识，整份作废
    Version {
        found: u32,
        expected: u32,
    },
    /// 把所有草稿都丢光了还是超过预算——只有元信息本身就有 4MB，实践中到不了这里
    TooLarge {
        bytes: usize,
        limit: usize,
    },
}

impl SessionError {
    fn io(err: std::io::Error) -> Self {
        SessionError::Io { reason: format!("{:?}", err.kind()), message: err.to_string() }
    }

    fn corrupt(message: impl Into<String>) -> Self {
        SessionError::Corrupt { message: message.into() }
    }
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::Io { message, .. } => f.write_str(message),
            SessionError::NoParent { path } => write!(f, "{path} 没有目录部分，无法确定临时文件位置"),
            SessionError::Corrupt { message } => write!(f, "会话文件读不回来：{message}"),
            SessionError::Version { found, expected } => write!(f, "会话文件是版本 {found}，本版本只认 {expected}"),
            SessionError::TooLarge { bytes, limit } => write!(f, "会话有 {bytes} 字节，超过上限 {limit}"),
        }
    }
}

impl std::error::Error for SessionError {}

impl From<WriteError> for SessionError {
    fn from(err: WriteError) -> Self {
        match err {
            WriteError::Io { reason, message } => SessionError::Io { reason, message },
            WriteError::NoParent { path } => SessionError::NoParent { path },
        }
    }
}

/// 读会话。
///
/// - 文件不存在 → `Ok(None)`。第一次启动是正常情况，不该报错。
/// - 文件存在但读不回来 → `Err`。前端要能说「上次的会话没能读回来」然后照常启动；
///   坏文件会被下一次保存直接覆盖掉，不需要用户去删。
pub fn load_session(path: &Path) -> Result<Option<Session>, SessionError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(SessionError::io(err)),
    };

    if bytes.len() > MAX_SESSION_BYTES {
        return Err(SessionError::TooLarge { bytes: bytes.len(), limit: MAX_SESSION_BYTES });
    }

    let session: Session = serde_json::from_slice(&bytes).map_err(|e| SessionError::corrupt(e.to_string()))?;
    if session.version != SESSION_VERSION {
        return Err(SessionError::Version { found: session.version, expected: SESSION_VERSION });
    }

    Ok(Some(session))
}

/// 写会话，原子。
///
/// 走 `write_bytes_atomic` 而不是 `write_text_atomic`：后者会做行尾还原与编码转换，
/// 那是给**用户文档**准备的。会话是 Rust 自己序列化出来的 UTF-8 JSON，
/// 过一个 GBK 档会把中文直接写坏，而且不报错。
///
/// 父目录不存在时会先建出来——`app_data_dir()` 在第一次运行前是不存在的。
pub fn save_session(path: &Path, mut session: Session) -> Result<SessionReport, SessionError> {
    // 版本号由存档格式自己说了算，不接受调用方传进来的值：前端把它当不透明数据往返，
    // 让它能写这个字段等于让它能伪造一份「看起来是新格式」的旧数据
    session.version = SESSION_VERSION;
    // 存之前也校验一遍。这里不拦的话，坏数据会变成一个**下次启动才炸**的文件，
    // 而那时距离写错它的那次保存已经隔了一整个会话
    session.validate().map_err(SessionError::corrupt)?;

    let mut bytes = serde_json::to_vec(&session).map_err(|e| SessionError::corrupt(e.to_string()))?;
    let mut dropped_drafts = 0;
    if bytes.len() > MAX_SESSION_BYTES {
        dropped_drafts = drop_drafts_to_fit(&mut session, bytes.len());
        bytes = serde_json::to_vec(&session).map_err(|e| SessionError::corrupt(e.to_string()))?;
        if bytes.len() > MAX_SESSION_BYTES {
            return Err(SessionError::TooLarge { bytes: bytes.len(), limit: MAX_SESSION_BYTES });
        }
    }

    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| SessionError::NoParent { path: path.display().to_string() })?;
    fs::create_dir_all(parent).map_err(SessionError::io)?;

    write_bytes_atomic(path, &bytes)?;

    Ok(SessionReport { bytes_written: bytes.len() as u64, dropped_drafts })
}

/// 从最大的草稿开始丢，直到「丢掉的原始字节数」补上超出的部分。返回丢掉的个数。
///
/// 一次就够，不需要「丢一个再序列化一次」的循环，理由是一条不等式：
/// JSON 转义只会让序列化后的草稿**不短于**它本身，所以丢掉一个原始长度 L 的草稿
/// 至少省下 L 字节（`Some("…")` 变成 `null`，还额外省下 key 和引号）。
/// 于是 Σ L ≥ excess ⇒ 新长度 ≤ 原长度 − excess = 上限。
///
/// 反过来说，把草稿全丢光还超预算，就说明**元信息本身**超了 4MB——
/// 那是前端 `MAX_SESSION_TABS` 该拦住的情况，这里只能报错。
fn drop_drafts_to_fit(session: &mut Session, serialized_len: usize) -> u32 {
    let excess = serialized_len - MAX_SESSION_BYTES;

    let draft_len = |tab: &SessionTab| tab.draft.as_ref().map_or(0, |d| d.len());

    // 大的先扔：预算固定的情况下，这样能让活下来的草稿数量最多
    let mut order: Vec<usize> = (0..session.tabs.len()).filter(|i| session.tabs[*i].draft.is_some()).collect();
    order.sort_by(|a, b| draft_len(&session.tabs[*b]).cmp(&draft_len(&session.tabs[*a])));

    let mut freed = 0;
    let mut dropped = 0;
    for i in order {
        if freed >= excess {
            break;
        }
        freed += draft_len(&session.tabs[i]);
        session.tabs[i].draft = None;
        dropped += 1;
    }
    dropped
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::{Encoding, LineEnding};

    fn tab(path: Option<&str>, draft: Option<&str>) -> SessionTab {
        SessionTab {
            path: path.map(|p| p.to_owned()),
            // 未命名文档也有一份格式：`format` 是标签的属性，不是「有没有路径」的附属品
            format: FileFormat { encoding: Encoding::Utf8, bom: false, eol: LineEnding::Lf },
            dirty: draft.is_some(),
            lossy: false,
            draft: draft.map(|d| d.to_owned()),
            selection: vec![(0, 0)],
            main: 0,
            scroll_top: 0.0,
            scroll_left: 0.0,
        }
    }

    fn session(tabs: Vec<SessionTab>) -> Session {
        Session {
            version: SESSION_VERSION,
            direction: PaneDirection::Row,
            focused: 0,
            tabs: tabs.clone(),
            panes: (0..tabs.len()).collect(),
            // 与项目树无关的用例占绝大多数，所以默认不开文件夹；
            // 要测项目的那几条自己覆写这个字段
            project: None,
        }
    }

    /// 最小可用会话：一个标签、一块分屏。
    fn minimal() -> Session {
        session(vec![tab(Some("/tmp/a.txt"), None)])
    }

    fn path_in(dir: &Path) -> std::path::PathBuf {
        dir.join(SESSION_FILE_NAME)
    }

    #[test]
    fn 存下来再读回来完全一致() {
        let dir = tempfile::tempdir().unwrap();
        let path = path_in(dir.path());

        let original = Session {
            version: SESSION_VERSION,
            direction: PaneDirection::Column,
            focused: 1,
            tabs: vec![
                tab(Some("/tmp/a.txt"), None),
                SessionTab {
                    path: None,
                    // 未命名文档 + 非默认格式 + lossy：这三样是「重启后悄悄丢一个决定」的高发区，
                    // 放在往返用例里一起钉
                    format: FileFormat { encoding: Encoding::Gbk, bom: true, eol: LineEnding::Crlf },
                    dirty: true,
                    lossy: true,
                    draft: Some("第一行\n第二行".into()),
                    selection: vec![(0, 3), (7, 7)],
                    main: 1,
                    scroll_top: 120.5,
                    scroll_left: 8.0,
                },
            ],
            panes: vec![1, 0],
            // 空字符串 `""` 是**根**那一层的 rel，不是「没有值」。它在 `expanded` 里
            // 必须能原样往返：丢了它，恢复出来的树是收起的，用户点开过的文件夹全缩回去了，
            // 而这件事没有任何报错——正是本模块最怕的那一类失败。
            project: Some(SessionProject {
                root: "/Users/me/code/vela".into(),
                expanded: vec!["".into(), "src".into(), "src/project".into()],
            }),
        };

        let report = save_session(&path, original.clone()).unwrap();
        assert_eq!(report.dropped_drafts, 0);
        assert_eq!(report.bytes_written, fs::read(&path).unwrap().len() as u64);

        let loaded = load_session(&path).unwrap().unwrap();
        assert_eq!(loaded, original, "往返之后会话变了");
    }

    #[test]
    fn 文件不存在时返回_none_而不是报错() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_session(&path_in(dir.path())).unwrap(), None);
    }

    #[test]
    fn 父目录不存在时会自动建出来() {
        // app_data_dir() 在第一次运行前不存在
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app").join("vela").join(SESSION_FILE_NAME);
        save_session(&path, minimal()).unwrap();
        assert!(load_session(&path).unwrap().is_some());
    }

    #[test]
    fn 不是_json_时报_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let path = path_in(dir.path());
        fs::write(&path, b"this is not json").unwrap();
        match load_session(&path) {
            Err(SessionError::Corrupt { .. }) => {}
            other => panic!("期望 Corrupt，实际 {other:?}"),
        }
    }

    #[test]
    fn 半个_json_也报_corrupt() {
        // 断电时 rename 没发生 → 旧文件完好；但如果哪天有人把它改成非原子写入，
        // 这就是会得到的东西
        let dir = tempfile::tempdir().unwrap();
        let path = path_in(dir.path());
        let full = serde_json::to_vec(&minimal()).unwrap();
        fs::write(&path, &full[..full.len() / 2]).unwrap();
        assert!(matches!(load_session(&path), Err(SessionError::Corrupt { .. })));
    }

    #[test]
    fn 版本号不认识时整份作废() {
        let dir = tempfile::tempdir().unwrap();
        let path = path_in(dir.path());
        let mut future = minimal();
        future.version = SESSION_VERSION + 1;
        // save_session 会强行改写 version，所以直接落盘
        fs::write(&path, serde_json::to_vec(&future).unwrap()).unwrap();

        match load_session(&path) {
            Err(SessionError::Version { found, expected }) => {
                assert_eq!((found, expected), (SESSION_VERSION + 1, SESSION_VERSION));
            }
            other => panic!("期望 Version，实际 {other:?}"),
        }
    }

    /// `save_session` 无视调用方给的 version：前端把它当不透明数据往返，
    /// 让它能写这个字段等于让它能伪造格式版本。
    #[test]
    fn 存盘时版本号由本模块决定() {
        let dir = tempfile::tempdir().unwrap();
        let path = path_in(dir.path());
        let mut bogus = minimal();
        bogus.version = 999;
        save_session(&path, bogus).unwrap();
        assert_eq!(load_session(&path).unwrap().unwrap().version, SESSION_VERSION);
    }

    #[test]
    fn 下标越界的会话被拒绝() {
        let dir = tempfile::tempdir().unwrap();
        let path = path_in(dir.path());

        // 每份 JSON 里共用的、与本用例无关的部分。抽成常量是为了让下面每条字符串里
        // 只剩下它真正要测的那个越界点
        const FMT: &str = r#""format":{"encoding":"utf8","bom":false,"eol":"lf"},"dirty":false,"lossy":false"#;
        let tab_json = |tail: &str| format!(r#"{{"path":null,{FMT},"draft":null,{tail}}}"#);
        let session_json = |tabs: &str, focused: usize, panes: &str| {
            format!(r#"{{"version":1,"direction":"row","focused":{focused},"tabs":[{tabs}],"panes":[{panes}]}}"#)
        };
        let ok_tab = tab_json(r#""selection":[[0,0]],"main":0,"scrollTop":0,"scrollLeft":0"#);

        // focused 越界、panes 越界、main 越界、空选区、空标签、空分屏：
        // 每一条的失败方式都是前端启动时一个 undefined 崩溃，所以必须在这里拦掉
        for raw in [
            session_json(&ok_tab, 3, "0"),
            session_json(&ok_tab, 0, "7"),
            session_json(&tab_json(r#""selection":[[0,0]],"main":4,"scrollTop":0,"scrollLeft":0"#), 0, "0"),
            session_json(&tab_json(r#""selection":[],"main":0,"scrollTop":0,"scrollLeft":0"#), 0, "0"),
            session_json("", 0, ""),
            session_json(&ok_tab, 0, ""),
        ] {
            fs::write(&path, &raw).unwrap();
            assert!(matches!(load_session(&path), Err(SessionError::Corrupt { .. })), "这份越界会话被接受了：{raw}");
        }
    }

    /// 4MiB 拦不住标签数：一个标签的元信息只有一百来字节，几万个也塞得进去，
    /// 而前端会照着建几万个 CodeMirror state，启动直接卡死。
    #[test]
    fn 标签数超过上限时整份作废() {
        let dir = tempfile::tempdir().unwrap();
        let path = path_in(dir.path());

        let tabs = |n: usize| (0..n).map(|i| tab(Some(&format!("/f{i}")), None)).collect();
        save_session(&path, session(tabs(MAX_SESSION_TABS))).unwrap();

        let over = session(tabs(MAX_SESSION_TABS + 1));
        match save_session(&path, over.clone()) {
            Err(SessionError::Corrupt { message }) => assert!(message.contains("超过上限 64"), "{message}"),
            other => panic!("期望 Corrupt，实际 {other:?}"),
        }

        // 文件形态走同一条路
        fs::write(&path, serde_json::to_vec(&over).unwrap()).unwrap();
        assert!(matches!(load_session(&path), Err(SessionError::Corrupt { .. })));
    }

    /// 一个标签同时显示在两块分屏里是 workspace 的不变量 2 明确排除的：
    /// 放开的话 `Tab.snapshot` 不再是「没显示时的唯一真相」，撤销历史与滚动位置会分叉成两份。
    #[test]
    fn 两块分屏指向同一个标签会被拒() {
        let dir = tempfile::tempdir().unwrap();
        let path = path_in(dir.path());
        let duplicated = Session {
            version: SESSION_VERSION,
            direction: PaneDirection::Row,
            focused: 0,
            tabs: vec![tab(Some("/a"), None)],
            panes: vec![0, 0],
            project: None,
        };

        match save_session(&path, duplicated.clone()) {
            Err(SessionError::Corrupt { message }) => assert!(message.contains("已经显示在另一块分屏"), "{message}"),
            other => panic!("期望 Corrupt，实际 {other:?}"),
        }
        assert!(!path.exists(), "被拒的保存不该留下文件");

        // 文件形态走同一条路
        fs::write(&path, serde_json::to_vec(&duplicated).unwrap()).unwrap();
        assert!(matches!(load_session(&path), Err(SessionError::Corrupt { .. })));
    }

    /// `focused` 是**分屏**下标不是标签下标——两者在只有一个标签时数值相同，
    /// 是最容易写错又最难发现的地方，所以单独钉一条。
    #[test]
    fn focused_指向分屏而不是标签() {
        let dir = tempfile::tempdir().unwrap();
        let path = path_in(dir.path());
        let mut s = session(vec![tab(Some("/a"), None), tab(Some("/b"), None)]);
        // 一块分屏显示第二个标签，聚焦它：focused 是 panes 的下标 0，不是标签下标 1
        s.panes = vec![1];
        s.focused = 0;
        save_session(&path, s.clone()).unwrap();
        let loaded = load_session(&path).unwrap().unwrap();
        assert_eq!(loaded.focused, 0);
        assert_eq!(loaded.panes, vec![1]);

        // focused=1 在只有一块分屏时必须被拒绝
        s.focused = 1;
        fs::write(&path, serde_json::to_vec(&s).unwrap()).unwrap();
        assert!(matches!(load_session(&path), Err(SessionError::Corrupt { .. })));
    }

    /// **M1-F 时代写下的存档必须还能读回来。**
    ///
    /// 这条是「加了 `project` 却不 bump `SESSION_VERSION`」那个决定的唯一依据：那个推理
    /// 成立与否，取决于旧文件解析成什么。要是这里变成 `Err(Version)` 或 `Err(Corrupt)`，
    /// 所有已经装了 M1-F 的用户重启一次就丢光会话——而他们只会认为「这功能坏了」。
    ///
    /// 摘掉键而不是另写一份字面量：字面量会与真实格式各自漂移，而「从当前格式里摘掉
    /// 这个键」永远精确等于「上一版写出来的东西」。
    #[test]
    fn 缺少_project_键的旧存档照常解析() {
        let dir = tempfile::tempdir().unwrap();
        let path = path_in(dir.path());

        let mut with_project = minimal();
        with_project.project = Some(SessionProject { root: "/repo".into(), expanded: vec!["".into()] });
        let current = serde_json::to_string(&with_project).unwrap();

        let legacy = current.replacen(r#","project":{"root":"/repo","expanded":[""]}"#, "", 1);
        assert_ne!(legacy, current, "没摘掉 project 键——上面的字面量与真实格式不一致了");

        fs::write(&path, &legacy).unwrap();
        let loaded = load_session(&path).unwrap().unwrap();
        assert_eq!(loaded.project, None, "旧存档该解析成「没打开文件夹」");
        // 关键在**其余部分一个字都没变**：降级只能是「少了新功能」，不能是「旧功能也坏了」
        assert_eq!(loaded.tabs, with_project.tabs);
        assert_eq!(loaded.panes, with_project.panes);

        // 结构体形态走同一条路（前端 invoke 的 payload 也可能不带这个键）
        assert_eq!(serde_json::from_str::<Session>(&legacy).unwrap().project, None);
    }

    /// `"project": null` 与「没有这个键」必须是同一件事。
    ///
    /// 前端**总是**带上这个键（没开文件夹时传 `null`），所以这条路径才是常态；
    /// 上一条测的缺键反而是特例。两条都钉住，是因为 serde 对「缺失」与「null」的
    /// 处理并不显然一致，而这里正好两种都会出现。
    #[test]
    fn project_为_null_等于没打开文件夹() {
        let dir = tempfile::tempdir().unwrap();
        let path = path_in(dir.path());
        // minimal() 的 project 就是 None，而序列化时**不**省略该键（见字段文档）
        assert!(serde_json::to_string(&minimal()).unwrap().ends_with(r#","project":null}"#));

        save_session(&path, minimal()).unwrap();
        assert_eq!(load_session(&path).unwrap().unwrap().project, None);
    }

    /// 空 root 不可能是任何一次 dialog 的返回值，它只可能来自手改或磁盘错误。
    ///
    /// 但**只**拦这一条：文件夹被移动/删除是常态（换机器、外挂盘没插），那种情况的
    /// 正确反应是「树照常建起来、那一行显示一句错误」，而不是「整份会话作废、
    /// 连标签都不恢复」。见 `validate` 里的注释。
    #[test]
    fn 空的项目根被拒() {
        let dir = tempfile::tempdir().unwrap();
        let path = path_in(dir.path());
        let mut s = minimal();
        s.project = Some(SessionProject { root: String::new(), expanded: vec!["".into()] });

        match save_session(&path, s.clone()) {
            Err(SessionError::Corrupt { message }) => assert!(message.contains("project.root"), "{message}"),
            other => panic!("期望 Corrupt，实际 {other:?}"),
        }
        assert!(!path.exists(), "被拒的保存不该留下文件");

        fs::write(&path, serde_json::to_vec(&s).unwrap()).unwrap();
        assert!(matches!(load_session(&path), Err(SessionError::Corrupt { .. })));

        // 反面对照：一个**不存在**的路径必须被接受。它会在 `list_dir` 那里变成
        // `not_found`，显示在根行上——赔掉整个会话是错的
        s.project = Some(SessionProject { root: "/这个文件夹已经不在了".into(), expanded: vec!["".into()] });
        save_session(&path, s).unwrap();
        assert!(load_session(&path).unwrap().unwrap().project.is_some());
    }

    /// `expanded` 的上限**不在这里**。
    ///
    /// 前端 `src/project/store.ts` 的 `MAX_RESTORED_EXPANDED` 已经在截断了，Rust 再截一遍
    /// 就有两个真相。它要限的成本（每条 `rel` 一次 `list_dir` 往返）是**前端**的成本，
    /// 由前端自己兜住才对；Rust 这一侧管的是 4MiB 的 payload 预算，那已经有
    /// `MAX_SESSION_BYTES` 在拦。这条用例钉住「Rust 不动 expanded」，免得将来有人
    /// 出于「多一层保险」在这里加个截断，然后两边各截一次、谁也说不清最终是多少条。
    #[test]
    fn 展开列表原样往返不在_rust_侧截断() {
        let dir = tempfile::tempdir().unwrap();
        let path = path_in(dir.path());
        let mut s = minimal();
        let expanded: Vec<String> = (0..900).map(|i| format!("d{i}")).collect();
        s.project = Some(SessionProject { root: "/repo".into(), expanded: expanded.clone() });

        save_session(&path, s).unwrap();
        let loaded = load_session(&path).unwrap().unwrap();
        assert_eq!(loaded.project.unwrap().expanded, expanded, "Rust 侧不该动 expanded");
    }

    #[test]
    fn 超过预算时从最大的草稿开始丢() {
        let dir = tempfile::tempdir().unwrap();
        let path = path_in(dir.path());

        // 三个草稿：小 / 中 / 大。总量超预算一点点，所以只该丢掉最大的那个
        let small = "s".repeat(MAX_SESSION_BYTES / 8);
        let medium = "m".repeat(MAX_SESSION_BYTES / 4);
        let large = "L".repeat(MAX_SESSION_BYTES);
        let s = session(vec![tab(None, Some(&small)), tab(None, Some(&medium)), tab(None, Some(&large))]);

        let report = save_session(&path, s).unwrap();
        assert_eq!(report.dropped_drafts, 1, "该丢一个，实际丢了 {}", report.dropped_drafts);
        assert!(report.bytes_written as usize <= MAX_SESSION_BYTES);

        let loaded = load_session(&path).unwrap().unwrap();
        assert_eq!(loaded.tabs[0].draft.as_deref(), Some(small.as_str()), "小草稿被误删");
        assert_eq!(loaded.tabs[1].draft.as_deref(), Some(medium.as_str()), "中草稿被误删");
        assert_eq!(loaded.tabs[2].draft, None, "最大的草稿没被丢掉");
        // 丢草稿不改 dirty：用户那个标签仍然是「有未保存改动」，只是内容没了
        assert!(loaded.tabs[2].dirty);
    }

    #[test]
    fn 草稿总量不超预算时一个都不丢() {
        let dir = tempfile::tempdir().unwrap();
        let path = path_in(dir.path());
        let s = session(vec![tab(None, Some(&"x".repeat(1024))), tab(None, Some("短草稿"))]);
        let report = save_session(&path, s).unwrap();
        assert_eq!(report.dropped_drafts, 0);
        assert_eq!(load_session(&path).unwrap().unwrap().tabs[1].draft.as_deref(), Some("短草稿"));
    }

    #[test]
    fn 超过预算的文件在读取时也被拒绝() {
        // 存档是**系统边界**：文件可能是别的版本、别的程序写的。
        // 放它过来的代价是把一个 4MB+ 的 payload 塞进 IPC，正是 §2.6 修正 1 要防的
        let dir = tempfile::tempdir().unwrap();
        let path = path_in(dir.path());
        let huge = session(vec![tab(None, Some(&"x".repeat(MAX_SESSION_BYTES + 1)))]);
        // 绕开 save_session 的裁剪，直接落盘
        fs::write(&path, serde_json::to_vec(&huge).unwrap()).unwrap();

        match load_session(&path) {
            Err(SessionError::TooLarge { bytes, limit }) => {
                assert!(bytes > limit);
                assert_eq!(limit, MAX_SESSION_BYTES);
            }
            other => panic!("期望 TooLarge，实际 {other:?}"),
        }
    }

    /// 元信息本身就超预算（实践中到不了，前端的 MAX_SESSION_TABS 拦在前面）时
    /// 必须报错，不能写一个下次启动读不回来的文件。
    #[test]
    fn 丢光草稿还是超预算时报错() {
        let dir = tempfile::tempdir().unwrap();
        let path = path_in(dir.path());

        // 用一个超长路径把「不含草稿的元信息」撑过 4MB
        let long_path = format!("/{}", "d".repeat(MAX_SESSION_BYTES));
        let s = session(vec![tab(Some(&long_path), Some("小草稿"))]);
        match save_session(&path, s) {
            Err(SessionError::TooLarge { bytes, limit }) => {
                assert!(bytes > limit);
                assert_eq!(limit, MAX_SESSION_BYTES);
            }
            other => panic!("期望 TooLarge，实际 {other:?}"),
        }
        assert!(!path.exists(), "报错的保存不该留下文件");
    }

    #[test]
    fn 裸文件名被拒绝() {
        match save_session(Path::new("session.json"), minimal()) {
            Err(SessionError::NoParent { path }) => assert_eq!(path, "session.json"),
            other => panic!("期望 NoParent，实际 {other:?}"),
        }
    }

    #[test]
    fn 保存后目录里只有会话文件() {
        let dir = tempfile::tempdir().unwrap();
        let path = path_in(dir.path());
        save_session(&path, minimal()).unwrap();
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n != SESSION_FILE_NAME)
            .collect();
        assert!(leftovers.is_empty(), "残留了 {leftovers:?}");
    }

    /// 覆盖写入必须是整份替换：这次的标签比上次少时，旧的不能留下尾巴。
    #[test]
    fn 第二次保存覆盖第一次() {
        let dir = tempfile::tempdir().unwrap();
        let path = path_in(dir.path());
        save_session(&path, session(vec![tab(Some("/a"), None), tab(Some("/b"), None)])).unwrap();
        save_session(&path, minimal()).unwrap();
        let loaded = load_session(&path).unwrap().unwrap();
        assert_eq!(loaded.tabs.len(), 1);
        assert_eq!(loaded.tabs[0].path.as_deref(), Some("/tmp/a.txt"));
    }

    #[test]
    fn 目标是目录时报_io_错误() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(load_session(dir.path()), Err(SessionError::Io { .. })));
    }
}
