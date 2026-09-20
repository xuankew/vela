//! 大文件的**只读**分片读取（M2-H，PLAN.md §2.4「文档模型归属」+ §3.4「M2-H 实施修正」1）。
//!
//! ## ⛔ 这一层没有 `ropey`——PLAN 原来那一行被改判了
//!
//! 原计划是「Rust 侧持有全文，前端按可视窗口请求分片」。落地时改成了「**文件留在磁盘上**，
//! Rust 侧只持有一份稀疏行索引」。理由不是省事，是那份计划与 §2.9 的预算直接打架：
//! 空转常驻内存的硬上限是 **200MB**，而 `Rope::from_reader` 要把整个文件读进来——
//! 一个 500MB 的日志就是 500MB 常驻，打开它就当场超预算两倍半，而且是**打开成功之后**
//! 才超，界面上看不出任何异常。
//!
//! 换成稀疏索引之后，常驻内存与文件大小**脱钩**了：256 MiB 的文件、10 字节一行，
//! 索引也就是 [`ANCHOR_STRIDE`] 一个锚点 8 字节 ≈ 210 KB。代价是「跳到第 N 行」要从
//! 最近的锚点顺着扫过去，最多 1023 行——那是几十 KB 的读，比多驻留几百 MB 便宜得多。
//!
//! ⚠️ **另一半理由是「只读」**：`ropey` 值钱的地方是增量编辑（O(log n) 插入），
//! 而这个模式按定义禁用编辑，于是那份能力一个字节都用不上。为一个用不到的能力
//! 付一整个依赖 + 一份内存，不划算。M2-E 手写模糊匹配而没引 fuzzy crate 是同一条判断。
//!
//! ## 三条口径与内联路径**不一样**，每一条都是明写的
//!
//! 1. **行数按 `wc -l` 那一套**：`\n` 的个数，加上「最后一个字节不是 `\n` 时补一行」。
//!    ⛔ 与 CM6 差一行——CM6 认为 `"a\n"` 有两行（第二行是空的）。分片视图里那一行
//!    会是一个凭空多出来的空行，而它下面什么也没有，所以这里不跟。
//! 2. **裸 `\r`（老 Mac）不算行尾**。内联路径的 `normalize_to_lf` 会把它折成 `\n`，
//!    这里不会：按 `\r` 分行要同时判「它后面是不是 `\n`」，那让锚点算术从「数一个字节」
//!    变成「数一个字节并回看下一个」，而收益是一种 1990 年代就停止生产的行尾。
//!    于是这类文件在分片视图里是**一整行**，撞上 [`MAX_PAGE_BYTES`] 之后被截断。
//! 3. **编码与行尾都只从头部 256 KiB 判**。内联路径看的是整份字节。
//!    ⚠️ 一份「前 256 KiB 是合法 UTF-8、后面是 GBK」的文件会被整体判成 UTF-8，
//!    后半截解出替换字符——而 `ShardPage::lossy` 会**逐页**如实报出来，所以不是静默的。
//!    行尾同理，而它只用于状态栏显示：分片模式**永远不写盘**，判错也毁不掉文件。
//!
//! ## ⛔ UTF-16 在这个模式下打不开
//!
//! 「数 `0x0A` 的个数就是行数」这条前提只在**单字节安全的编码**上成立：UTF-8 的续字节
//! 是 0x80–0xBF，GBK 的尾字节是 0x40–0xFE（都不含 0x0A），所以 0x0A 在它俩里面永远
//! 只可能是行尾。UTF-16 不是——`\n` 是 `0A 00` 或 `00 0A`，而 `00` 也可能出现在别的
//! 字符里，锚点还必须落在偶数偏移上。做得到，但那要给这一层的每一个函数都加一个
//! 「奇偶」参数，而现实里 >4 MiB 的 UTF-16 文本文件极其罕见。
//!
//! ⚠️ **这不是一个退步**：这类文件今天压根打不开（`read_text` 在 4 MiB 就拒了），
//! M2-H 之后是「打得开一个明确的错误」而不是「打得开」。返回
//! [`ReadError::UnsupportedEncoding`]，文案里说清楚是编码的问题、不是文件坏了。

use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

use super::encoding::{decode, decode_as, Decoded, Encoding};
use super::eol::{detect_eol, LineEnding};
use super::read::ReadError;

/// 每多少行记一个字节锚点。
///
/// 这个数是「索引多大」与「跳一行要顺扫多远」之间的那个旋钮：
///
/// | 文件 | 行数（按 10 字节/行） | 锚点数 | 索引内存 | 跳行最坏顺扫 |
/// |---|---|---|---|---|
/// | 256 MiB | 2684 万 | 2.6 万 | **205 KB** | 1023 行 ≈ 10 KB |
///
/// 调小（比如 64）索引会大 16 倍而跳行只快 16 倍——**两边都不是瓶颈**，
/// 所以按「索引内存留在几百 KB 量级」这一头定，1024 是个顺手的 2 的幂。
///
/// ⚠️ 顺序滚动（唯一常见的用法）压根不走顺扫：连续的两页几乎总是落在同一个锚点段里，
/// 而 `read_page` 每次都从锚点重新 seek，所以「顺扫」的成本只在**跳行**时才付。
pub const ANCHOR_STRIDE: u64 = 1024;

/// 只读分片模式能接住的文件上限。
///
/// ⚠️ **这个数字是量出来的，不是拍的。** 上限的真正约束是「打开一个文件要扫一整遍建索引」，
/// 而 §2.9 给「打开 10 万行文件」的预算是 **< 2s**。实测（Apple Silicon，32 MiB / 52 万行）：
///
/// | 构建 | 吞吐 | 折算 256 MiB |
/// |---|---|---|
/// | release（连跑三次） | **4478 / 4614 / 4922 MiB/s** | **≈ 0.06s** |
/// | debug | 246 MiB/s | ≈ 1.04s |
///
/// 🔴 **两个数都是文件已经在 page cache 里的**（测试自己刚写完那一份），也就是量的是
/// **扫描本身**、不含磁盘。冷读是磁盘限速的：内置 SSD 上大概还是零点几秒，
/// 而**网络卷上 256 MiB 会直接超预算**——那一段**没有实测数据**，是这个上限真正的软处。
/// 复测：`cargo test -p vela-core --release 扫描吞吐 -- --nocapture`。
///
/// 再往上抬要付的不是内存（索引与文件大小脱钩了，见模块文档），也不是 CPU，
/// 而是**打开那一下的等待**：索引必须建完才知道总行数，而总行数是滚动条高度的依据，
/// 所以这一步没法懒。要支持更大的文件，得改成「先给一个估算的行数、后台把索引补完、
/// 补完再校正滚动条」——那是另一个功能，不是一个更大的常量。
pub const MAX_SHARD_BYTES: u64 = 256 * 1024 * 1024;

/// 一次 `read_page` 最多返回几行。
///
/// 前端要的是「可视区 + 上下各几行 overscan」，几十行而已。这个上限挡的是
/// 「有人递一个 `count = 1e9`」：它与 [`MAX_PAGE_BYTES`] 是两道独立的闸，
/// 前者按行数、后者按字节，**两个都要**——一百万个空行只有一百万字节，
/// 一个 1 GB 的单行只有一行。
pub const MAX_PAGE_LINES: u64 = 1024;

/// 一次 `read_page` 最多读多少字节。
///
/// 🔴 **这一条是安全阀，不是优化。** 没有它的话，一个只有一行、长 200 MB 的文件
/// （压缩过的 JSON、一行一条的日志转储、`tr '\n' ' '` 的产物——都真实存在）会让
/// `read_page(0, 1)` 读满 200 MB、序列化成 JSON、再在 WKWebView 里反序列化一遍。
/// 那正是 §2.4 那句「绝不在 IPC 里传整个大文件」要防的现场，而它会从一个
/// **看起来完全正常**的请求里冒出来。
///
/// 撞上时 [`ShardPage::truncated`] 为真，`lines` 的最后一条是**不完整的**——
/// UI 要说一句，不能假装那是整行。
pub const MAX_PAGE_BYTES: u64 = 1024 * 1024;

/// 建索引时一次读多少。1 MiB：小于它就多 syscall，大于它就白占一块只用一次的缓冲。
const SCAN_CHUNK: usize = 1 << 20;

/// `read_page` 一次读多少。比 `SCAN_CHUNK` 小一个数量级：它读的是「几十行」，
/// 而一屏撑死几百 KB，读 1 MiB 大概率要多做一次没用的拷贝。
const PAGE_CHUNK: usize = 64 * 1024;

/// 探编码与行尾时读多少。
///
/// ⚠️ 只看头部是**改判**，口径差异见模块文档第 3 条。256 KiB 足够让
/// 「这份字节是不是合法 UTF-8」这个判断有意义，而它只占一次 `read`。
const PROBE_HEAD_BYTES: usize = 256 * 1024;

/// 一份稀疏行索引。**不含文件句柄**——句柄表是 src-tauri 的事，
/// 与 `watcher` 那一层同一条分界（vela-core 不持有任何会自己回调进来的东西）。
/// 唯一持有 fd 的地方是 [`Shard`]，理由写在那儿。
///
/// 于是 [`LineIndex::read_page`] 收一个 `reader` 参数：单测传 `Cursor`（一个字节都不落盘），
/// 生产传 [`Shard`] 里那一个 fd。
///
/// ⚠️ 它描述的是**某一个 inode 的某一份字节**。文件被原子替换（写临时文件 + rename，
/// 本项目自己的 `save_file` 就是这么写的）之后，旧句柄仍然指向旧 inode，
/// 于是索引与内容**仍然自洽**——只是它们一起变成了历史。要看到新内容必须整个重开一次分片。
#[derive(Debug, Clone)]
pub struct LineIndex {
    /// `anchors[i]` = 第 `i * ANCHOR_STRIDE` 行的起始字节偏移。
    /// `anchors[0]` 是 BOM 的长度（无 BOM 时为 0），于是第 0 行不会带着 U+FEFF
    anchors: Vec<u64>,
    total_lines: u64,
    encoding: Encoding,
    /// BOM 占几个字节。留着它是为了 `read_page` 解码时不必再问一次编码
    bom_len: u64,
}

/// 一页正文。
///
/// ⚠️ `lines` 是**一行一条**而不是拼成一个大字符串：拼起来的话「末尾那个空行到底
/// 是一行还是分隔符」就成了一个前端必须猜的问题，而猜错的症状是滚动到底时
/// 多一行或少一行——不报错，只是对不上。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShardPage {
    /// 这一页第一条行的行号（0 起）。**是夹过的那一个**，不是调用方递进来的原始值
    pub start: u64,
    /// 每行一条，**不含**行尾。CRLF 文件里那个 `\r` 已经剥掉了
    pub lines: Vec<String>,
    /// true = 撞了 [`MAX_PAGE_BYTES`]，`lines` 的最后一条**不完整**、后面还有行没给
    pub truncated: bool,
    /// true = 这一页解码时有字节无法映射，正文里含 U+FFFD。
    /// 逐页报而不是整体报一次：编码是从头部判的（模块文档第 3 条），
    /// 而「前 256 KiB 正常、后面是另一种编码」这种文件的症状就落在这一个字段上
    pub lossy: bool,
}

/// `open_shard` 交给前端的元信息。**不含正文**——正文靠 `read_page` 一页一页要。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShardHeader {
    /// 总行数，口径见模块文档第 1 条（`wc -l` 那一套，⛔ 与 CM6 差一行）
    pub total_lines: u64,
    /// 文件字节数
    pub bytes: u64,
    pub encoding: Encoding,
    pub bom: bool,
    /// ⚠️ 只从头部 256 KiB 判出来的，见模块文档第 3 条。**只用于显示**：
    /// 分片模式永远不写盘，所以它判错也毁不掉文件
    pub eol: LineEnding,
    /// 头部那一段解码就有损
    pub lossy: bool,
}

/// 一个**打开了的**分片：元信息 + 行索引 + 建索引时用的那个 fd。
///
/// ## 🔴 为什么 `file` 是私有的、只能靠 [`Shard::read_page`] 用
///
/// 索引里存的是一堆字节偏移量，它们只对**建索引时那一个 inode** 有意义。
/// 把 `file` 开成 `pub` 的话，调用方完全可以留着索引、另外 `File::open` 一次同一个路径——
/// 而在 macOS 上「写临时文件 + rename」是本项目自己的落盘方式（`write_bytes_atomic`），
/// 于是这两次 open 之间文件被换掉是**真实可能**的时序，换掉之后索引与新内容错位，
/// 症状是正文里出现莫名其妙的半截行，而 `lossy` 是 false、`truncated` 是 false，
/// 没有任何一个字段会报警。
///
/// 把 fd 关在这个结构里，「索引与内容来自同一个 inode」就从一句注释变成结构上成立。
///
/// ⚠️ 反过来说，它**仍然会变成历史**：外部原子替换之后，这个 fd 指向的还是旧 inode，
/// 索引与内容一起旧下去，两者**自洽**。要看到新内容必须整个重开一次分片——
/// 前端拿到 `vela://file-changed` 之后就是这么做的。
#[derive(Debug)]
pub struct Shard {
    pub header: ShardHeader,
    pub index: LineIndex,
    file: File,
}

impl Shard {
    /// 读 `[start, start + count)` 这几行。夹取与安全阀全在 [`LineIndex::read_page`] 里。
    pub fn read_page(&mut self, start: u64, count: u64) -> io::Result<ShardPage> {
        self.index.read_page(&mut self.file, start, count)
    }
}

/// 打开一个大文件：探编码 → 建索引 → 交出 [`Shard`]。
///
/// ⛔ 不检查下限：一个 3 字节的文件也能建索引。要不要走分片模式是调用方的决定
/// （前端只在 `open_file` 回了 `too_large` 之后才调过来），而单测要在小文件上跑，
/// 每次写 4 MiB 太贵。
pub fn open_shard(path: &Path) -> Result<Shard, ReadError> {
    let meta = fs::metadata(path).map_err(ReadError::io)?;
    if meta.is_dir() {
        return Err(ReadError::Directory { path: path.display().to_string() });
    }
    let bytes = meta.len();
    if bytes > MAX_SHARD_BYTES {
        return Err(ReadError::TooLarge { bytes, limit: MAX_SHARD_BYTES });
    }

    let mut file = fs::File::open(path).map_err(ReadError::io)?;
    let mut head = vec![0u8; PROBE_HEAD_BYTES.min(bytes as usize)];
    let filled = read_up_to(&mut file, &mut head).map_err(ReadError::io)?;
    let probed = probe_head(&head[..filled]);

    if matches!(probed.encoding, Encoding::Utf16Le | Encoding::Utf16Be) {
        return Err(ReadError::UnsupportedEncoding { encoding: probed.encoding, bytes });
    }
    let bom_len = if probed.bom { probed.encoding.bom_len() as u64 } else { 0 };

    file.seek(SeekFrom::Start(0)).map_err(ReadError::io)?;
    // ⚠️ `&mut file` 而不是 `file`：这个 fd 建完索引还要留着给 `read_page` 用。
    // 移动进去的话 `open_shard` 就只能把它丢掉，而调用方另开一个 fd 会引入
    // 「索引与内容不是同一个 inode」的窗口（见 [`Shard`] 的文档）
    let index = LineIndex::build(&mut file, probed.encoding, bom_len).map_err(ReadError::io)?;

    let header = ShardHeader {
        total_lines: index.total_lines(),
        bytes,
        encoding: probed.encoding,
        bom: probed.bom,
        eol: detect_eol(&probed.text),
        lossy: probed.lossy,
    };
    Ok(Shard { header, index, file })
}

/// 只拿头部一段字节判编码。
///
/// 🔴 **必须先把可能被切断的尾巴回退掉**：头部是按固定字节数切的，切点大概率落在
/// 一个多字节字符中间，而 `from_utf8` 会因为那半个字符判整段非法——于是一份**纯 UTF-8**
/// 的文件会被判成 GBK。症状是正文变成一片汉字乱码，而 `lossy` 为 false，
/// 与 `encoding::decode` 文件头说的那个「静默地错」是同一类。
fn probe_head(head: &[u8]) -> Decoded {
    match trim_incomplete_tail(head) {
        Some(trimmed) => decode(trimmed),
        // 回退 3 个字节都救不回来 = 这段压根不是 UTF-8，交给 `decode` 走 BOM/GBK 那两条
        None => decode(head),
    }
}

/// 把「可能切在字符中间」的尾巴回退掉，返回一个保证是合法 UTF-8 的前缀。
///
/// `None` = 回退 3 个字节以内都救不回来。UTF-8 一个字符最多 4 字节，所以 3 就是全部可能。
fn trim_incomplete_tail(head: &[u8]) -> Option<&[u8]> {
    for cut in 0..=3usize.min(head.len()) {
        let end = head.len() - cut;
        if std::str::from_utf8(&head[..end]).is_ok() {
            return Some(&head[..end]);
        }
    }
    None
}

impl LineIndex {
    /// 扫一遍 `reader` 建索引。**这是一次完整的顺序读**，也就是「打开一个大文件」
    /// 那一下的主要成本——它没法懒，因为总行数是滚动条高度的依据。
    ///
    /// `reader` 必须已经定位到 BOM 之后**或者**把 `bom_len` 交给这里跳过（这里会跳）。
    pub fn build<R: Read>(mut reader: R, encoding: Encoding, bom_len: u64) -> io::Result<LineIndex> {
        if bom_len > 0 {
            let mut skip = [0u8; 3];
            // BOM 最多 3 个字节，而能走到这里说明文件里确实有它
            reader.read_exact(&mut skip[..bom_len as usize])?;
        }

        let mut anchors: Vec<u64> = vec![bom_len];
        let mut buf = vec![0u8; SCAN_CHUNK];
        let mut newlines: u64 = 0;
        // `buf[0]` 在文件里的绝对偏移
        let mut pos: u64 = bom_len;
        let mut last: Option<u8> = None;

        loop {
            let n = read_up_to(&mut reader, &mut buf)?;
            if n == 0 {
                break;
            }
            for i in memchr::memchr_iter(b'\n', &buf[..n]) {
                newlines += 1;
                if newlines % ANCHOR_STRIDE == 0 {
                    // 第 `newlines` 行（0 起）从这个 `\n` 的下一个字节开始
                    anchors.push(pos + i as u64 + 1);
                }
            }
            last = Some(buf[n - 1]);
            pos += n as u64;
        }

        // 口径见模块文档第 1 条：末尾没有 `\n` 才算多一行，空文件是 0 行
        let total_lines = newlines + u64::from(last.is_some_and(|b| b != b'\n'));
        Ok(LineIndex { anchors, total_lines, encoding, bom_len })
    }

    pub fn total_lines(&self) -> u64 {
        self.total_lines
    }

    pub fn encoding(&self) -> Encoding {
        self.encoding
    }

    pub fn has_bom(&self) -> bool {
        self.bom_len > 0
    }

    /// 锚点个数。留给测试断言「索引确实稀疏」——只看 `total_lines` 的话，
    /// 「每行都记了一个锚点」这个退化实现也是绿的，而它的内存是这里的 1024 倍。
    pub fn anchor_count(&self) -> usize {
        self.anchors.len()
    }

    /// 读 `[start, start + count)` 这几行。
    ///
    /// 🔴 **每一个下标都夹过一遍**，包括看起来「不可能越界」的那几个。
    /// release profile 里写着 `panic = "abort"`（根 `Cargo.toml`），
    /// 所以一次越界不是「这条命令失败」，是**整个 Vela 进程没了**——用户手上
    /// 那些没保存的草稿一起没。这一层拿的是前端递来的两个整数，
    /// 而前端那两个数来自滚动位置，也就是来自浮点除法。
    pub fn read_page<R: Read + Seek>(&self, mut reader: R, start: u64, count: u64) -> io::Result<ShardPage> {
        let start = start.min(self.total_lines);
        let count = count.min(MAX_PAGE_LINES).min(self.total_lines - start);
        if count == 0 {
            return Ok(ShardPage { start, lines: Vec::new(), truncated: false, lossy: false });
        }

        let anchor = (start / ANCHOR_STRIDE) as usize;
        // `anchors` 至少有一个元素（`build` 里那个 `vec![bom_len]`），所以 `len() - 1` 不会下溢；
        // 而 `anchor` 可能等于 `len()`——总行数不是 `ANCHOR_STRIDE` 的整数倍时，
        // 最后一段行没有自己的锚点，要用最后那一个
        let anchor = anchor.min(self.anchors.len() - 1);
        let offset = self.anchors[anchor];
        let skip = (start - anchor as u64 * ANCHOR_STRIDE) as usize;

        reader.seek(SeekFrom::Start(offset))?;
        let want = skip + count as usize;
        let cap = MAX_PAGE_BYTES as usize;

        let mut raw: Vec<u8> = Vec::new();
        let mut buf = [0u8; PAGE_CHUNK];
        let mut seen = 0usize;
        while seen < want && raw.len() < cap {
            let room = (cap - raw.len()).min(PAGE_CHUNK);
            let n = read_up_to(&mut reader, &mut buf[..room])?;
            if n == 0 {
                break;
            }
            seen += memchr::memchr_iter(b'\n', &buf[..n]).count();
            raw.extend_from_slice(&buf[..n]);
        }
        // ⚠️ 只有撞了字节上限才算截断。**读到 EOF 不算**：最后一行本来就可能没有 `\n`，
        // 那种情况下 `seen` 天然比 `want` 小 1，把它报成截断会让 UI 在每一个正常文件的
        // 最后一页都说一句「这一行太长」
        let truncated = seen < want && raw.len() >= cap;

        // `decode_as` 会试图剥 BOM，而 `raw` 里不可能有（`anchors[0]` 就在 BOM 之后），
        // 剥不掉时它原样解码——正好是要的行为。只取 `text` 与 `lossy`，
        // 它报的 `bom` 一律是 false，所以 ⛔ 不能拿它当「这个文件有没有 BOM」用
        let decoded = decode_as(&raw, self.encoding);
        let all: Vec<&str> = decoded.text.split('\n').collect();

        let from = skip.min(all.len());
        let to = (skip + count as usize).min(all.len());
        let lines = all[from..to].iter().map(|line| strip_cr(line).to_owned()).collect();

        Ok(ShardPage { start, lines, truncated, lossy: decoded.lossy })
    }
}

/// CRLF 文件里那一行的尾巴上挂着一个 `\r`。
///
/// ⚠️ 只剥**行尾那一个**，不碰行内的（裸 `\r` 不当行尾，见模块文档第 2 条）。
/// 换成 `normalize_to_lf` 的话，一个老 Mac 文件会被拆成很多行，
/// 而 `total_lines` 是按 `\n` 数的——两边行数对不上，滚动条当场失准，而且不报错。
fn strip_cr(line: &str) -> &str {
    line.strip_suffix('\r').unwrap_or(line)
}

/// `read_exact` 但**不把 EOF 当错误**：返回实际读到多少。
///
/// 扫描与读页两处的循环都靠它——`Read::read` 允许短读，直接用它的话
/// `memchr` 数出来的换行数会漏，症状是总行数偏小、滚动到底时最后几行不见了。
fn read_up_to<R: Read>(mut reader: R, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
            Err(err) => return Err(err),
        }
    }
    Ok(filled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// 直接在内存里建索引。⛔ 不落盘：这些用例要跑几百次，
    /// 而 `open_shard` 那条路每次都要真的建一个文件
    fn index_of(text: &[u8]) -> LineIndex {
        LineIndex::build(Cursor::new(text), Encoding::Utf8, 0).unwrap()
    }

    fn page_of(text: &[u8], start: u64, count: u64) -> ShardPage {
        let index = index_of(text);
        index.read_page(Cursor::new(text), start, count).unwrap()
    }

    fn lines_of(text: &str) -> Vec<String> {
        text.split('\n').map(str::to_owned).collect()
    }

    #[test]
    fn 行数是换行个数_末尾没有换行才多一行() {
        assert_eq!(index_of(b"a\nb\n").total_lines(), 2);
        assert_eq!(index_of(b"a\nb").total_lines(), 2);
        assert_eq!(index_of(b"a\n\n\n").total_lines(), 3);
        // ⛔ 与 CM6 差一行：CM6 会说 `"a\n"` 有两行。口径见模块文档第 1 条
        assert_eq!(index_of(b"\n").total_lines(), 1);
    }

    #[test]
    fn 空文件是零行而不是一行() {
        assert_eq!(index_of(b"").total_lines(), 0);
        // 而读它不炸，只是什么也不给
        let page = page_of(b"", 0, 10);
        assert_eq!(page.lines, Vec::<String>::new());
        assert!(!page.truncated);
    }

    #[test]
    fn 逐页读回来拼起来就是原文() {
        let text = "第一行\nsecond\n\t缩进\n\n最后一行\n";
        let bytes = text.as_bytes();
        let index = index_of(bytes);
        assert_eq!(index.total_lines(), 5);

        let mut joined: Vec<String> = Vec::new();
        for start in (0..index.total_lines()).step_by(2) {
            joined.extend(index.read_page(Cursor::new(bytes), start, 2).unwrap().lines);
        }
        // 原文以 `\n` 结尾 → `split` 会多给一个空串，去掉才是「每行一条」
        let mut want = lines_of(text);
        want.pop();
        assert_eq!(joined, want);
    }

    /// 🔴 这一条钉的是「跨锚点」：`ANCHOR_STRIDE` 是 1024，所以要么真的造 1024 行以上，
    /// 要么这条测试压根没走到 `anchor > 0` 那个分支——而那个分支正是唯一有除法的地方。
    #[test]
    fn 跨过锚点边界时行号仍然对得上() {
        let total = (ANCHOR_STRIDE * 2 + 7) as usize;
        let text: String = (0..total).map(|i| format!("line-{i}\n")).collect();
        let bytes = text.as_bytes();
        let index = index_of(bytes);

        assert_eq!(index.total_lines(), total as u64);
        // 三个锚点：第 0 行、第 1024 行、第 2048 行
        assert_eq!(index.anchor_count(), 3);

        for start in [0u64, 1, 1023, ANCHOR_STRIDE, ANCHOR_STRIDE + 1, 2047, 2048, total as u64 - 1] {
            let page = index.read_page(Cursor::new(bytes), start, 1).unwrap();
            assert_eq!(page.start, start);
            assert_eq!(page.lines, vec![format!("line-{start}")], "行号 {start}");
        }
    }

    #[test]
    fn 索引确实是稀疏的_不是每行一个锚点() {
        let total = (ANCHOR_STRIDE * 5) as usize;
        let text: String = (0..total).map(|i| format!("l{i}\n")).collect();
        let index = index_of(text.as_bytes());

        // 5120 行 → 锚点是第 0/1024/2048/3072/4096 行，共 6 个（含开头那个）
        assert_eq!(index.anchor_count(), 6);
        assert_eq!(index.total_lines(), total as u64);
        // 退化实现（每行一个锚点）会让这一条变成 5121，内存差 1024 倍
        assert!(index.anchor_count() * 100 < total, "锚点密到不像稀疏索引了");
    }

    #[test]
    fn crlf_的行尾那个_cr_被剥掉_行内的不碰() {
        let bytes = b"a\r\nb\r\nc\r\n";
        assert_eq!(index_of(bytes).total_lines(), 3);
        let page = page_of(bytes, 0, 3);
        assert_eq!(page.lines, vec!["a".to_owned(), "b".into(), "c".into()]);

        // 行内的 `\r` 原样留着：这一层不折裸 CR（模块文档第 2 条）
        let weird = page_of(b"x\ry\n", 0, 1);
        assert_eq!(weird.lines, vec!["x\ry".to_owned()]);
    }

    /// ⚠️ 裸 CR 文件在这个模式下是**一整行**，与内联路径不一样。
    /// 这条测试钉的是「不一样」这件事本身被知道，而不是它碰巧成立。
    #[test]
    fn 裸_cr_的老_mac_文件算一整行() {
        let bytes = b"a\rb\rc";
        assert_eq!(index_of(bytes).total_lines(), 1);
        assert_eq!(page_of(bytes, 0, 10).lines, vec!["a\rb\rc".to_owned()]);
    }

    #[test]
    fn count_超过剩余行数时给到文件末尾为止() {
        let bytes = b"a\nb\nc";
        let index = index_of(bytes);

        let page = index.read_page(Cursor::new(bytes), 1, 100).unwrap();
        assert_eq!(page.start, 1);
        assert_eq!(page.lines, vec!["b".to_owned(), "c".into()]);
        // ⛔ 读到 EOF 不算截断，否则每一个正常文件的最后一页都会多一句警告
        assert!(!page.truncated);
    }

    #[test]
    fn start_超过总行数时夹到末尾并返回空页() {
        let bytes = b"a\nb\n";
        let index = index_of(bytes);

        let page = index.read_page(Cursor::new(bytes), 9999, 10).unwrap();
        assert_eq!(page.start, 2);
        assert!(page.lines.is_empty());
    }

    /// 🔴 这一条钉的是 [`MAX_PAGE_BYTES`] 那个安全阀。
    ///
    /// 没有它的话，一个「只有一行、长 200MB」的文件会让一次看起来完全正常的
    /// `read_page(0, 50)` 变成一个 200MB 的 IPC payload。
    #[test]
    fn 一行长到撞上字节上限时被截断并如实报出来() {
        // 一个 MAX_PAGE_BYTES 那么长的单行，后面再跟几行正常的
        let mut text = "x".repeat(MAX_PAGE_BYTES as usize);
        text.push('\n');
        text.push_str("tail-1\ntail-2\n");
        let bytes = text.as_bytes();
        let index = index_of(bytes);

        assert_eq!(index.total_lines(), 3);
        let page = index.read_page(Cursor::new(bytes), 0, 3).unwrap();

        assert!(page.truncated, "撞了字节上限却没报截断");
        // 只给了那一条（不完整的）长行，后面两行没读到
        assert_eq!(page.lines.len(), 1);
        assert_eq!(page.lines[0].len(), MAX_PAGE_BYTES as usize);
        // 而字节数没有超：这一条闸的意义就在于「payload 有界」
        assert!(page.lines.iter().map(String::len).sum::<usize>() <= MAX_PAGE_BYTES as usize);
    }

    #[test]
    fn 行数上限把_count_夹住() {
        let total = (MAX_PAGE_LINES + 50) as usize;
        let text: String = (0..total).map(|i| format!("l{i}\n")).collect();
        let bytes = text.as_bytes();
        let index = index_of(bytes);

        // 递一个荒唐的 count：一百万个空行只有几 MB，字节那道闸拦不住，靠的是这一道
        let page = index.read_page(Cursor::new(bytes), 0, 1_000_000).unwrap();
        assert_eq!(page.lines.len(), MAX_PAGE_LINES as usize);
        assert!(!page.truncated, "按行数夹住不是截断");
    }

    #[test]
    fn 空行也算一行() {
        let bytes = b"a\n\n\nb\n";
        assert_eq!(index_of(bytes).total_lines(), 4);
        assert_eq!(page_of(bytes, 0, 4).lines, lines_of("a\n\n\nb"));
    }

    #[test]
    fn 多字节字符跨过读块边界时不被切断() {
        // 这是这一层最容易出错的地方：读的时候按字节切（`PAGE_CHUNK` = 64 KiB），
        // 解码的时候必须落在字符边界上。切错的症状是 `lossy = true` 加一个 U+FFFD
        let line = "汉字".repeat(20_000); // 12 万字节，跨过 64 KiB 的 PAGE_CHUNK
        let text = format!("{line}\n第二行\n");
        let bytes = text.as_bytes();
        let index = index_of(bytes);

        let page = index.read_page(Cursor::new(bytes), 0, 2).unwrap();
        // ⚠️ 失败信息里用 `chars().take(10)` 而不是 `[..40]`：正文本身就是多字节的，
        // 按字节切一个 `&str` 会当场 panic，于是「断言失败」变成「测试进程崩了」
        assert!(!page.lossy, "多字节字符被切断了：{}", page.lines[0].chars().take(10).collect::<String>());
        assert_eq!(page.lines, vec![line, "第二行".to_owned()]);
    }

    #[test]
    fn bom_不进第一行_也不影响行数() {
        let mut bytes = vec![0xEFu8, 0xBB, 0xBF];
        bytes.extend_from_slice("第一行\n第二行\n".as_bytes());

        let file = tempfile::tempdir().unwrap();
        let path = file.path().join("bom.txt");
        fs::write(&path, &bytes).unwrap();

        let mut shard = open_shard(&path).unwrap();
        assert!(shard.header.bom);
        assert_eq!(shard.header.encoding, Encoding::Utf8);
        assert_eq!(shard.header.total_lines, 2);
        assert!(shard.index.has_bom());
        // ⚠️ 这一条是整个 `bom_len` 存在的理由：少了它，第 0 行会带着一个 U+FEFF，
        // 而那是个看不见的字符，断言只会莫名其妙地差一个位
        assert_eq!(shard.read_page(0, 2).unwrap().lines, lines_of("第一行\n第二行"));
    }

    #[test]
    fn 头部被切在多字节字符中间时仍然判成_utf8() {
        // 🔴 这条钉的是 `trim_incomplete_tail`。构造方式：造一个「前 PROBE_HEAD_BYTES
        // 个字节正好切断一个汉字」的文件。少了那一步回退的话，`from_utf8` 判整段非法，
        // 于是一份纯 UTF-8 的文件被判成 GBK，正文变成一片乱码而 lossy 还是 false
        let filler = "汉".repeat(PROBE_HEAD_BYTES); // 每个 3 字节，一定切得断
        let text = format!("{filler}\n第二行\n");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("utf8.txt");
        fs::write(&path, text.as_bytes()).unwrap();

        let mut head = vec![0u8; PROBE_HEAD_BYTES];
        let n = read_up_to(&mut fs::File::open(&path).unwrap(), &mut head).unwrap();
        assert_eq!(n, PROBE_HEAD_BYTES);
        assert!(std::str::from_utf8(&head).is_err(), "这条用例的前提没了：头部压根没被切断");
        assert_eq!(trim_incomplete_tail(&head).map(|t| t.len()), Some(PROBE_HEAD_BYTES - 1));

        let shard = open_shard(&path).unwrap();
        assert_eq!(shard.header.encoding, Encoding::Utf8);
        assert!(!shard.header.lossy);
    }

    #[test]
    fn gbk_文件按_gbk_分页解出来() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gbk.txt");
        // 「模」的 GBK 是 C4 A3，而 C4 A3 同时是合法 UTF-8（"ģ"）——
        // 探测会判 UTF-8，所以这里用 `LineIndex::build` 显式指定编码，
        // 走的是 `read_text_as` 那条「用户自己改判」的同一条路
        let mut bytes: Vec<u8> = Vec::new();
        for _ in 0..10 {
            bytes.extend_from_slice(&[0xC4u8, 0xA3]);
            bytes.push(b'\n');
        }
        fs::write(&path, &bytes).unwrap();

        let file = fs::File::open(&path).unwrap();
        let index = LineIndex::build(file, Encoding::Gbk, 0).unwrap();
        assert_eq!(index.total_lines(), 10);

        let page = index.read_page(&mut fs::File::open(&path).unwrap(), 3, 2).unwrap();
        assert_eq!(page.lines, vec!["模".to_owned(), "模".into()]);
        assert!(!page.lossy);
    }

    /// ⛔ UTF-16 在分片模式下打不开，理由见模块文档最后一节。
    #[test]
    fn utf16_被明确拒绝而不是解成乱码() {
        let dir = tempfile::tempdir().unwrap();
        for (name, bom) in [("le.bin", [0xFFu8, 0xFE]), ("be.bin", [0xFE, 0xFF])] {
            let path = dir.path().join(name);
            let mut bytes = bom.to_vec();
            // 「a\n」在 UTF-16 里是 4 个字节，而 `0A` 与 `00` 的相对位置随端序变
            for _ in 0..4 {
                bytes.extend_from_slice(if name == "le.bin" {
                    &[0x61, 0x00, 0x0A, 0x00]
                } else {
                    &[0x00, 0x61, 0x00, 0x0A]
                });
            }
            fs::write(&path, &bytes).unwrap();

            match open_shard(&path) {
                Err(ReadError::UnsupportedEncoding { encoding, .. }) => {
                    let want = if name == "le.bin" { Encoding::Utf16Le } else { Encoding::Utf16Be };
                    assert_eq!(encoding, want);
                }
                other => panic!("期望 UnsupportedEncoding，实际 {other:?}"),
            }
        }
    }

    #[test]
    fn 上限与目录这两道闸与内联路径同一套() {
        let dir = tempfile::tempdir().unwrap();
        match open_shard(dir.path()) {
            Err(ReadError::Directory { .. }) => {}
            other => panic!("期望 Directory，实际 {other:?}"),
        }
        match open_shard(&dir.path().join("nope.txt")) {
            Err(ReadError::Io { reason, .. }) => assert_eq!(reason, "NotFound"),
            other => panic!("期望 Io/NotFound，实际 {other:?}"),
        }

        // 超过 MAX_SHARD_BYTES：⛔ 只造一个「声称很大」的文件，不真的写 256MB。
        // `set_len` 造稀疏文件，metadata 报的是设定值，而扫描会在第一个 EOF 就停
        let path = dir.path().join("huge.bin");
        fs::File::create(&path).unwrap().set_len(MAX_SHARD_BYTES + 1).unwrap();
        match open_shard(&path) {
            Err(ReadError::TooLarge { bytes, limit }) => {
                assert_eq!(bytes, MAX_SHARD_BYTES + 1);
                assert_eq!(limit, MAX_SHARD_BYTES);
            }
            other => panic!("期望 TooLarge，实际 {other:?}"),
        }
    }

    #[test]
    fn 行尾从头部判出来() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("crlf.txt");
        fs::write(&path, b"a = 1\r\nb = 2\r\n").unwrap();

        let mut shard = open_shard(&path).unwrap();
        assert_eq!(shard.header.eol, LineEnding::Crlf);
        assert_eq!(shard.header.total_lines, 2);
        // 行尾只用于显示，但正文那一条规矩仍然生效：交出去的行不带 `\r`
        assert_eq!(shard.read_page(0, 2).unwrap().lines, lines_of("a = 1\nb = 2"));
    }

    /// 🔴 钉的是 [`Shard`] 那条「索引与 fd 绑在一起」的性质**在文件被换掉之后是什么样**。
    ///
    /// 外部原子替换（本项目自己的 `write_bytes_atomic` 就是这么写的）之后，
    /// 这个 fd 指的还是旧 inode，于是索引与内容**一起旧下去、彼此自洽**——
    /// 不是「旧索引 + 新内容」那种错位。前端拿到 `vela://file-changed` 之后
    /// 整个重开一次分片，靠的就是这一条：重开之前看到的东西不会自相矛盾。
    #[test]
    fn 文件被原子替换之后旧分片仍然自洽地读旧内容() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.txt");
        fs::write(&path, b"old-1\nold-2\nold-3\n").unwrap();

        let mut shard = open_shard(&path).unwrap();
        assert_eq!(shard.header.total_lines, 3);

        // 写临时文件 + rename，正是 `write_bytes_atomic` 的形状
        let tmp = dir.path().join("log.txt.tmp");
        fs::write(&tmp, b"new-1\nnew-2\nnew-3\nnew-4\nnew-5\nnew-6\nnew-7\n").unwrap();
        fs::rename(&tmp, &path).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new-1\nnew-2\nnew-3\nnew-4\nnew-5\nnew-6\nnew-7\n");

        // 旧分片看到的仍然是旧内容，而且行数与正文对得上（不是半截行）
        assert_eq!(shard.header.total_lines, 3);
        assert_eq!(shard.read_page(0, 10).unwrap().lines, lines_of("old-1\nold-2\nold-3"));

        // 重开一次才看得见新内容
        let reopened = open_shard(&path).unwrap();
        assert_eq!(reopened.header.total_lines, 7);
    }

    #[test]
    fn 元信息的线上形状() {
        // ⚠️ 与 `src/ipc/shard.test.ts` 是同一条契约的两半，改一边必须改另一边
        let header = ShardHeader {
            total_lines: 12,
            bytes: 34,
            encoding: Encoding::Gbk,
            bom: true,
            eol: LineEnding::Crlf,
            lossy: false,
        };
        assert_eq!(
            serde_json::to_string(&header).unwrap(),
            r#"{"totalLines":12,"bytes":34,"encoding":"gbk","bom":true,"eol":"crlf","lossy":false}"#
        );

        let page = ShardPage { start: 3, lines: vec!["a".to_owned(), "b".into()], truncated: true, lossy: true };
        assert_eq!(
            serde_json::to_string(&page).unwrap(),
            r#"{"start":3,"lines":["a","b"],"truncated":true,"lossy":true}"#
        );
    }

    #[test]
    fn 不支持编码的错误也在线上形状里() {
        let err = ReadError::UnsupportedEncoding { encoding: Encoding::Utf16Le, bytes: 99 };
        assert_eq!(
            serde_json::to_string(&err).unwrap(),
            r#"{"kind":"unsupported_encoding","encoding":"utf16_le","bytes":99}"#
        );
    }

    /// 扫描吞吐。**量出来的数字决定 [`MAX_SHARD_BYTES`] 能不能是 256 MiB**：
    /// §2.9 给「打开」的预算是 2s，而建索引必须扫完整个文件（总行数是滚动条的依据，没法懒）。
    /// 读数记在那个常量的文档里。
    ///
    /// ⚠️ 这条用例**不写死断言**，机器快慢差几倍是正常的，而一条随机红的性能测试
    /// 比没有更糟。它断言的是一个宽松到不可能失败的下界，真数字打在 stdout 上。
    /// 要复测就 `cargo test -p vela-core --release 扫描吞吐 -- --nocapture`。
    ///
    /// ⚠️ 它也是这个模块里**唯一一条要真的写 32 MiB 到磁盘**的用例（debug 下约 0.13s）。
    /// 换来的是「上限那个数不是拍的」这件事可以在任何一台机器上重验。
    #[test]
    fn 扫描吞吐() {
        use std::time::Instant;

        // 32 MiB、每行 64 字节 ≈ 52 万行。刻意不造 256 MiB：那会让 `cargo test` 慢好几秒，
        // 而吞吐是线性的，按 32 MiB 折算足够
        const SIZE: usize = 32 * 1024 * 1024;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("scan.txt");
        {
            let mut file = fs::File::create(&path).unwrap();
            // 1024 行一块（64 KiB），与 `SCAN_CHUNK` 同量级，省得写三万次 syscall
            let chunk = format!("{}\n", "y".repeat(63)).repeat(1024);
            let mut written = 0;
            while written < SIZE {
                io::Write::write_all(&mut file, chunk.as_bytes()).unwrap();
                written += chunk.len();
            }
        }
        let bytes = fs::metadata(&path).unwrap().len();

        let started = Instant::now();
        let shard = open_shard(&path).unwrap();
        let elapsed = started.elapsed();

        let mib = bytes as f64 / (1024.0 * 1024.0);
        let secs = elapsed.as_secs_f64();
        println!(
            "建索引：{mib:.1} MiB / {secs:.3}s = {:.0} MiB/s，{} 行 / {} 个锚点",
            mib / secs,
            shard.index.total_lines(),
            shard.index.anchor_count()
        );

        // 下界宽松到只有「实现整个坏掉」才会红。实测 debug 246 MiB/s、release ~4600 MiB/s，
        // 25 这个数比 debug 还低一个数量级——它挡的是「不小心写成逐字节循环」或
        // 「每行都 push 一个锚点」这类算法级退步（那会让吞吐掉到个位数），
        // ⛔ 不是用来挡机器慢的。CI 的 ubuntu runner 负载高时也不该红
        assert!(mib / secs > 25.0, "扫描吞吐 {:.0} MiB/s 低于 25 MiB/s 的下界", mib / secs);
    }
}
