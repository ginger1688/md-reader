// v0.1：只做「打开文件 + 读内容」，把渲染与交互全部留给前端。
// v0.2：补一条「按 GBK 重读」，给非 UTF-8 的旧文件留一条活路。

use std::sync::Mutex;

/// 文件不是合法 UTF-8 时返回这个约定错误码，前端据此给出本地化提示。
const NOT_UTF8: &str = "ERR_NOT_UTF8";

/*
 * 替换字符 U+FFFD 占比超过这个比例，就判定「这文件根本不是这个编码」。
 *
 * GBK 解码器对任意字节序列都有输出 —— 给它一坨二进制，它会老老实实吐出一串
 * 方块，既不报错也不吭声。不做这一步检测的话，用户拿到的就是一屏乱码，
 * 这跟 UTF-8 失败时选择报错而不是渲染乱码是同一个取舍。
 *
 * 1% 是留给少量生僻字的余量：老文档里偶尔有一两个字解不出来属于正常。
 */
const REPLACEMENT_RATIO_LIMIT: f64 = 0.01;

/// 读取一个 Markdown 文件的完整文本内容。
///
/// 只接受 UTF-8。非 UTF-8（例如 GBK 编码的旧文件）会返回 Err，
/// 由前端展示错误提示并给出「按 GBK 打开」的入口。
/// 文件不是合法 UTF-8 时返回这个约定错误码，前端据此给出本地化提示。
/// 其余情况直接透传 std::io::Error 的描述文本。
#[tauri::command]
fn read_markdown_file(path: &str) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        // 非 UTF-8（典型是 GBK 的旧文件）单独识别：与其渲染成一片乱码，
        // 不如明确告诉用户打不开，并把重读的入口交给他。
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => Err(NOT_UTF8.to_string()),
        Err(e) => Err(e.to_string()),
    }
}

/*
 * 按指定编码读取文件。目前只有 GBK 一个入口，够用。
 *
 * 为什么走 GBK 而不是 GB18030：WHATWG 规范里 "gbk" 这个标签映射到的解码器
 * 本身就覆盖了 GB18030 的四字节序列，两者在解码能力上没有差别，
 * 但 GBK 是用户认知里的那个名字，按钮上就该这么写。
 */
#[tauri::command]
fn read_file_as(path: &str, encoding: &str) -> Result<String, String> {
    let decoder = match encoding {
        "gbk" => encoding_rs::GBK,
        other => return Err(format!("ERR_UNKNOWN_ENCODING:{other}")),
    };

    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let (text, _, _) = decoder.decode(&bytes);

    // 太短的文件算比例没有统计意义，直接放行。
    if text.chars().count() >= 32 {
        let replacements = text.chars().filter(|c| *c == '\u{FFFD}').count();
        let ratio = replacements as f64 / text.chars().count() as f64;
        if ratio > REPLACEMENT_RATIO_LIMIT {
            return Err(NOT_UTF8.to_string());
        }
    }

    Ok(text.into_owned())
}

/// 取走启动时命令行里带的待打开文件路径。
///
/// 文件关联双击打开时，Windows 会把 .md 路径作为 argv[1] 传进来。
/// 用 take 而非 clone：这个值只应被消费一次，
/// 否则前端热更新后重新挂载会重复打开同一个文件。
#[tauri::command]
fn take_startup_file(state: tauri::State<Mutex<Option<String>>>) -> Option<String> {
    state.lock().ok().and_then(|mut guard| guard.take())
}

/// 从命令行参数里挑出第一个「存在的文件」。
/// 跳过 --xxx 形式的开关，避免把标志位误当成文件名。
fn startup_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| !arg.starts_with('-') && std::path::Path::new(arg).is_file())
}

/*
 * 目录列表项。serde 派生出的 JSON 字段顺序稳定，前端可以直接 type 出来。
 *
 * 路径分隔符全部用系统原生的形式（Windows 上是 `\`），方便与 fileAssociations
 * 启动后 invoke('take_startup_file') 拿到的路径在字符串上等价 —— 比较路径
 * 时不需要做 Path::join 之类的归一化。
 *
 * is_dir 让前端不用看扩展名就能决定显示「文件夹图标」还是「文件图标」。
 */
#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

/*
 * 列出一个目录里的直接子项。
 *
 * 排序：目录优先，然后按不区分大小写的文件名升序。
 *
 * 错误以字符串透传，前端 catch 后直接拿 .toString()。和 read_markdown_file
 * 的取舍保持一致。
 *
 * 为什么不递归列出整棵树：v0.3 文件库只要求「一层目录 + 按需下钻」，
 * 一次性把整个盘子的 md 全列出来对几千个文件级的目录是几十毫秒的 IO，
 * 体验上是能感知的卡顿。当前 UI 也是先一层，下钻再调一次本函数。
 *
 * 文件过滤：只把 .md / .markdown / .txt 露出来；其他类型在阅读器里也用不上，
 * 提前过滤让前端不用再做这层判断。
 */
#[tauri::command]
fn list_directory(path: &str) -> Result<Vec<DirEntry>, String> {
    let entries = std::fs::read_dir(path).map_err(|e| e.to_string())?;
    let mut out: Vec<DirEntry> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let meta = entry.metadata().ok()?;
            let is_dir = meta.is_dir();
            if !is_dir {
                let name = entry.file_name().to_string_lossy().into_owned();
                let lower = name.to_ascii_lowercase();
                if !(lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".txt")) {
                    return None;
                }
            }
            Some(DirEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: entry.path().to_string_lossy().into_owned(),
                is_dir,
            })
        })
        .collect();
    // 目录在前，文件在后；同类型按不区分大小写的字母序排。
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()),
    });
    Ok(out)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(startup_file()))
        .invoke_handler(tauri::generate_handler![
            read_markdown_file,
            read_file_as,
            list_directory,
            take_startup_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
