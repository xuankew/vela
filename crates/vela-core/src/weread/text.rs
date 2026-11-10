//! 文本与时间的小工具：锚点哈希、日期格式化、列表项压平、文件名净化。
//!
//! ## ⚠️ 这一层逐字对齐 `weread.mjs`，因为锚点是**跨工具、跨设备的地址**
//!
//! `anchor(bookmarkId)` 是写进笔记正文的那串字符，用户拿它按 `⌘F` 找回一条划线
//! （🔴 微信读书的回包里**没有任何 link 字段**，跳转做不到，锚点是唯一的回指手段）。
//! 于是它一旦变值，旧笔记里所有锚点集体失效。两个工具（CLI 与 Vela）、两台设备必须算出
//! 同一个串，所以这里的黄金值是从 `weread.mjs` 的函数**实际跑出来的**，不是照着公式推的。
//!
//! 唯一的刻意分歧见 [`safe_name`]：JS 那版会在表情符号中间切出一个孤立代理项，那是 bug，
//! ⛔ 不抄。
//!
//! ## ⛔ 不加 `chrono`
//!
//! 这里只需要 UTC 的「秒 → 年月日时分」，一个 20 行的 `civil_from_days` 就够，
//! 而且它能在单测里把 2000 闰日、2038、纪元零点这几头一次钉完。引一个日期库换来的是
//! 一个许可证条目、一段编译时间，和一批用不上的时区能力。

/// CRC-32（IEEE 802.3，多项式 `0xEDB88320`，初值与末值都取反）。
///
/// ⚠️ 与 JS 那份一样是**按 UTF-8 字节**算的：`"中文划线"` 的锚点由它的 UTF-8 编码决定，
/// 按 UTF-16 码元算会得到另一个数。
const fn crc_table() -> [u32; 256] {
    let mut table = [0_u32; 256];
    let mut n = 0_usize;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
}

const CRC_TABLE: [u32; 256] = crc_table();

/// 标准 CRC-32。返回值是 `u32`，与 JS 那个 `>>> 0` 同域。
pub fn crc32(text: &str) -> u32 {
    let mut crc = 0xFFFF_FFFF_u32;
    for byte in text.as_bytes() {
        crc = CRC_TABLE[((crc ^ u32::from(*byte)) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

/// `u32` → base36，小写，与 JS 的 `Number.prototype.toString(36)` 同形。
fn base36(mut value: u32) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_owned();
    }
    let mut out = String::new();
    while value > 0 {
        out.insert(0, char::from(DIGITS[(value % 36) as usize]));
        value /= 36;
    }
    out
}

/// 一条划线或一条想法的锚点：`crc32(id)` 的 base36 写法，约 7 个字符。
///
/// 🔴 **不依赖数组下标**：`weread.mjs` 一开始想用序号，但序号会随上游新增划线整体漂移，
/// 昨天的「第 12 条」今天指向另一句正文。哈希 id 才是稳定的地址。
pub fn anchor(id: &str) -> String {
    base36(crc32(id))
}

/// 世界时的「年-月-日」，从 Unix 秒算。周期按 400 年一格切，闰规则在一格里自相似。
///
/// ⚠️ **用的是 UTC，不是本地时区**——与 JS 的 `toISOString()` 逐字一致。后果是本地深夜
/// 打的一条想法会显示成前一天。这是**已知的、两边一致的**偏差：改成 UTC 之外任何一套，
/// 都会让 CLI 与 Vela 在同一份笔记上给出两个日期。
///
/// 「3 月起的年」（March-based year）是这套算法的关键：把年界推到 3 月，`doy` 的公式
/// 在一整格里就不用为 2 月特判。`(4*doe+3)/1461` 是它的近似解，两个边界要补：
/// 百年那一格少算一年、era 最后一格多算一年（1461 天/4 年这个数认不出 1700/1800/1900
/// 不是闰年，也认不出 2000 是）。下面那一次条件加一同时管住这两处，已对 1860～2134 逐日
/// 与 JS 的 `toISOString()` 全量对过。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468; // 距 0000-03-01 的天数
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let mut yoe = (4 * doe + 3) / 1461;
    if yoe < 399 && era_start_day(yoe + 1) <= doe {
        yoe += 1;
    }
    let doy = doe - era_start_day(yoe); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]，3 月算第 0 格
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (era * 400 + yoe + i64::from(m <= 2), m as u32, d as u32)
}

/// era 起点之后第 `yoe` 个「3 月起的年」的第一天，用天数表示。
/// `+ yoe/4 - yoe/100` 是那一格里的闰日数：四个里多一个，整百的三个减掉。
fn era_start_day(yoe: i64) -> i64 {
    yoe * 365 + yoe / 4 - yoe / 100
}

/// `Unix 秒 → "YYYY-MM-DD"`。
///
/// ⚠️ `None` 与 `Some(0)` 都回空串，这是**照抄 JS 的 `ts ? … : ''`**：`createTime` 缺失时
/// 笔记行尾就什么都不带，而不是硬写一个 1970-01-01。0 在这套 API 里就是「没有」。
pub fn day_of(unix_seconds: Option<i64>) -> String {
    let Some(ts) = unix_seconds.filter(|ts| *ts != 0) else {
        return String::new();
    };
    let (y, m, d) = civil_from_days(ts.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// `Unix 秒 → "YYYY-MM-DD HH:MM"`，同样 UTC。用在素材文件开头那一行的「同步于」。
pub fn stamp_of(unix_seconds: i64) -> String {
    let (y, m, d) = civil_from_days(unix_seconds.div_euclid(86_400));
    let secs = unix_seconds.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}", secs / 3600 % 24, secs / 60 % 60)
}

/// `range`（形如 `"2959-3007"`）的起点，用来在同一章里按**正文顺序**排划线。
///
/// ⚠️ 不用 `createTime` 排序：那是「什么时候划的」，同一段书可以今天划前半句、
/// 明天划后半句。起点才是正文里的顺序。
///
/// 缺失时回 [`NO_POSITION`]，排在最后——与 JS 那个 `Number.MAX_SAFE_INTEGER` 同义，
/// 但⛔ 不是同一个数（`i64::MAX`）。这个值只当排序键用，永远不进文本，所以差别不可观察。
pub fn range_start(range: Option<&str>) -> i64 {
    let head: String = range.unwrap_or_default().chars().take_while(char::is_ascii_digit).collect();
    head.parse::<i64>().unwrap_or(NO_POSITION)
}

/// 「没有正文位置」的排序键，排最后。
pub const NO_POSITION: i64 = i64::MAX;

/// 「没有划线时间」的排序键，排最后。与 [`NO_POSITION`] 同一个数、不同的含义：
/// 一个是正文位置认不出，一个是时间戳缺失。⚠️ 两者都只当排序键用，永远不进文本。
pub const NO_TIME: i64 = i64::MAX;

/// 把一条划线/想法的正文压成单行列表项。
///
/// 🔴 **必须换不掉行**：正文里一个换行就把一条列表项裂成两条 Markdown 条目，
/// 之后那段的锚点行就挂错位置了。连续空白（含不间断空格 `U+00A0`、全角空格 `U+3000`、
/// 窄空格 `U+2009`）一律并成一个普通空格，首尾去掉——两边（JS 的 `\s+` 与 Rust 的
/// `char::is_whitespace`）按 Unicode `White_Space` 属性取的是同一套字符。
pub fn flatten(text: Option<&str>) -> String {
    text.unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 文件名净化：把文件系统不让用的那十个字符换成 `·`，再压空白，再截断。
///
/// ⚠️ 替换用 `·` 而不是删掉，是为了**可辨认**：`a/b` 变 `ab` 会让两个不同的书名撞成
/// 同一个文件，变 `a·b` 就不会。
///
/// 🔴 **这里与 JS 有一处刻意的分歧**：`weread.mjs` 的 `.slice(0, max)` 数的是
/// **UTF-16 码元**，实测 `safeName("🙂".repeat(10), 9)` 回的是 `"🙂🙂🙂🙂\uD83D"`——
/// 末尾那个孤立代理项写进文件名是残缺字节，写进 JSON 是非法字符串。Rust 按 `char` 切，
/// 不可能切出半个码点。⛔ 不要为了「和 CLI 一致」把这行改回去：一致的对象是合法名字，
/// 不是这个 bug。
pub fn safe_name(raw: Option<&str>, max_chars: usize) -> String {
    const FORBIDDEN: &str = "/\\:*?\"<>|";
    let replaced: String =
        raw.unwrap_or_default().chars().map(|c| if FORBIDDEN.contains(c) { '·' } else { c }).collect();
    let collapsed = flatten(Some(replaced.as_str()));
    collapsed.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️ 黄金值来源：本机 `node` 跑 `weread.mjs` 的 `crc32` / `anchor` 得到的输出，
    /// 同版本同输入逐字抄下来。**不是**照着 CRC 公式推的——推出来的值只能证明
    /// 「我认为该这么算」，跑出来的值才证明「两台设备会算出同一个串」。
    const ANCHOR_VECTORS: &[(&str, u32, &str)] = &[
        ("", 0, "0"),
        ("1001", 3_273_692_033, "1i52kxt"),
        ("1002", 1_512_686_139, "p0m43f"),
        ("1003", 758_051_501, "cjboa5"),
        ("r1", 219_023_793, "3mefu9"),
        ("bk1_1_10-20", 2_616_105_044, "179k7kk"),
        ("3300000001_7_100-140", 622_394_726, "aak2ue"),
        ("中文划线", 1_574_242_163, "q19h0z"),
        ("a", 3_904_355_907, "1skjwar"),
    ];

    #[test]
    fn 锚点与跑出来的黄金值逐字相同() {
        for (id, sum, text) in ANCHOR_VECTORS {
            assert_eq!(crc32(id), *sum, "crc32({id:?})");
            assert_eq!(anchor(id), *text, "anchor({id:?})");
        }
    }

    #[test]
    fn 同一批标识的锚点互不相同且稳定() {
        let once: Vec<String> = ANCHOR_VECTORS.iter().map(|v| anchor(v.0)).collect();
        let twice: Vec<String> = ANCHOR_VECTORS.iter().map(|v| anchor(v.0)).collect();
        assert_eq!(once, twice);
        let mut sorted = once.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), once.len(), "锚点撞车了：{once:?}");
    }

    #[test]
    fn 日期用世界时而非本地时区() {
        assert_eq!(day_of(Some(1_740_000_000)), "2025-02-19");
        assert_eq!(day_of(Some(1_735_689_599)), "2024-12-31");
        assert_eq!(day_of(Some(1)), "1970-01-01");
    }

    #[test]
    fn 缺失与零都回空串而不是纪元零点() {
        // 照抄 JS 的 `ts ? … : ''`：0 在这套 API 里就是「没有」，
        // 硬写 1970-01-01 会让一条没有时间戳的划线看起来是 55 年前划的
        assert_eq!(day_of(None), "");
        assert_eq!(day_of(Some(0)), "");
    }

    #[test]
    fn 闰日与三十八年边界() {
        assert_eq!(day_of(Some(951_782_400)), "2000-02-29");
        assert_eq!(day_of(Some(2_147_483_647)), "2038-01-19");
        assert_eq!(day_of(Some(-1)), "1969-12-31");
    }

    #[test]
    fn 时间戳带时分且分不进位到次日() {
        assert_eq!(stamp_of(1_735_689_599), "2024-12-31 23:59");
        assert_eq!(stamp_of(1_740_000_100), "2025-02-19 21:21");
        assert_eq!(stamp_of(1_740_000_000), "2025-02-19 21:20");
        assert_eq!(stamp_of(0), "1970-01-01 00:00");
    }

    #[test]
    fn 正文起点取前导数字认不出排最后() {
        assert_eq!(range_start(Some("2959-3007")), 2959);
        assert_eq!(range_start(Some("7")), 7);
        assert_eq!(range_start(Some("abc")), NO_POSITION);
        assert_eq!(range_start(Some("")), NO_POSITION);
        assert_eq!(range_start(None), NO_POSITION);
        assert!(range_start(Some("abc")) > range_start(Some("0-1")));
    }

    #[test]
    fn 空白折叠把不间断与全角空格也算成空白() {
        assert_eq!(flatten(Some("a\t\n b")), "a b");
        assert_eq!(flatten(Some("   \u{a0}x\u{a0}y  ")), "x y");
        assert_eq!(flatten(Some("a\u{2009}b")), "a b");
        assert_eq!(flatten(Some("\u{3000}\n")), "");
        assert_eq!(flatten(None), "");
    }

    #[test]
    fn 换行绝不能活到列表项里() {
        // 一个换行就把一条列表项裂成两条 Markdown 条目，后面的锚点行会挂错位置
        assert!(!flatten(Some("上段\n下段")).contains('\n'));
        assert_eq!(flatten(Some("上段\n下段")), "上段 下段");
    }

    #[test]
    fn 文件名净化换成点而不是删掉() {
        // 删掉会让 `a/b` 与 `ab` 两本不同的书撞成同一个文件
        assert_eq!(safe_name(Some("a/b\\c:d*e?f\"g<h>i|j"), 40), "a·b·c·d·e·f·g·h·i·j");
        assert_eq!(safe_name(Some("  多   空格  "), 40), "多 空格");
        assert_eq!(safe_name(None, 40), "");
    }

    #[test]
    fn 截断不切半个码点这是刻意分歧的一处() {
        // JS 的 `slice(0, 9)` 数的是 UTF-16 码元，实测回 "🙂🙂🙂🙂\uD83D"：
        // 末尾是半个码点，写进文件名是残缺字节。Rust 按 char 切，切不出半个。
        let emojis = "🙂".repeat(10);
        assert_eq!(safe_name(Some(&emojis), 9), "🙂".repeat(9));
        let long = "一二三四五六七八九十".repeat(4);
        assert_eq!(safe_name(Some(&long), 40).chars().count(), 40);
    }
}
