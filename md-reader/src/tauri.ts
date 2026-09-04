/// 是否跑在 Tauri 窗口里。
///
/// 浏览器里 `npm run dev` 时 @tauri-apps/api 的方法会抛错，
/// 所有需要调 Rust 命令或 Tauri 专属能力的地方都得先判断这个。
export const inTauri = '__TAURI_INTERNALS__' in window
