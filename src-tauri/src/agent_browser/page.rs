//! Pure helpers around the in-page script (`page.js`) and CDP input: expressions, key names,
//! exception text. Unit-tested without a browser.

use serde_json::Value;

/// Helpers evaluated in the tab's isolated world (see the file header).
pub const PAGE_JS: &str = include_str!("page.js");

/// Name of the isolated world (`Page.createIsolatedWorld`).
pub const WORLD_NAME: &str = "gridkeeper";

/// `__gk.run(op, args)` in the isolated world (the helper script is (re)defined first, idempotently).
pub fn op_expression(op: &str, args: &Value) -> String {
    format!("{PAGE_JS}\n;globalThis.__gk.run({}, {})", Value::String(op.into()), args)
}

/// The element behind `ref` as a remote object (for `DOM.setFileInputFiles`).
pub fn file_input_expression(r: &str) -> String {
    format!("{PAGE_JS}\n;globalThis.__gk.fileInput({})", Value::String(r.into()))
}

/// `browser_evaluate`: a function (`() => ...`, `async () => ...`, `function () {}`) is called; anything
/// else is evaluated as an expression / script.
pub fn eval_expression(src: &str) -> String {
    let s = src.trim();
    let looks_like_fn = s.starts_with("function")
        || s.starts_with("async ")
        || (s.starts_with('(') && s.contains("=>"))
        || s.split_once("=>").is_some_and(|(head, _)| {
            let h = head.trim();
            !h.is_empty() && h.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$')
        });
    if looks_like_fn { format!("({s})()") } else { s.to_string() }
}

/// A readable message from `Runtime.evaluate`'s `exceptionDetails`.
pub fn exception_text(details: &Value) -> String {
    let desc = details.pointer("/exception/description").and_then(Value::as_str);
    let value = details.pointer("/exception/value").and_then(Value::as_str);
    let text = details.get("text").and_then(Value::as_str);
    let raw = desc.or(value).or(text).unwrap_or("JavaScript error");
    // First line only ("Error: message" without the stack), without the "Error: " prefix.
    let first = raw.lines().next().unwrap_or(raw);
    first.strip_prefix("Error: ").unwrap_or(first).to_string()
}

pub const MOD_ALT: u32 = 1;
pub const MOD_CTRL: u32 = 2;
pub const MOD_META: u32 = 4;
pub const MOD_SHIFT: u32 = 8;

/// One key for `Input.dispatchKeyEvent`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeySpec {
    pub key: String,
    pub code: String,
    pub key_code: u32,
    /// Text the key types (none with Ctrl / Alt / Meta held, or for non-printing keys).
    pub text: Option<String>,
    pub modifiers: u32,
}

fn named_key(name: &str) -> Option<(&'static str, &'static str, u32, Option<&'static str>)> {
    let k = match name.to_ascii_lowercase().as_str() {
        "enter" | "return" => ("Enter", "Enter", 13, Some("\r")),
        "tab" => ("Tab", "Tab", 9, None),
        "escape" | "esc" => ("Escape", "Escape", 27, None),
        "backspace" => ("Backspace", "Backspace", 8, None),
        "delete" | "del" => ("Delete", "Delete", 46, None),
        "arrowup" | "up" => ("ArrowUp", "ArrowUp", 38, None),
        "arrowdown" | "down" => ("ArrowDown", "ArrowDown", 40, None),
        "arrowleft" | "left" => ("ArrowLeft", "ArrowLeft", 37, None),
        "arrowright" | "right" => ("ArrowRight", "ArrowRight", 39, None),
        "home" => ("Home", "Home", 36, None),
        "end" => ("End", "End", 35, None),
        "pageup" => ("PageUp", "PageUp", 33, None),
        "pagedown" => ("PageDown", "PageDown", 34, None),
        "insert" => ("Insert", "Insert", 45, None),
        "space" | " " => (" ", "Space", 32, Some(" ")),
        "f1" => ("F1", "F1", 112, None),
        "f2" => ("F2", "F2", 113, None),
        "f3" => ("F3", "F3", 114, None),
        "f4" => ("F4", "F4", 115, None),
        "f5" => ("F5", "F5", 116, None),
        "f6" => ("F6", "F6", 117, None),
        "f7" => ("F7", "F7", 118, None),
        "f8" => ("F8", "F8", 119, None),
        "f9" => ("F9", "F9", 120, None),
        "f10" => ("F10", "F10", 121, None),
        "f11" => ("F11", "F11", 122, None),
        "f12" => ("F12", "F12", 123, None),
        _ => return None,
    };
    Some(k)
}

/// Parse `Enter`, `a`, `Control+a`, `Shift+Tab`, `Meta+Enter` ... (a lone `+` is the plus key).
pub fn key_spec(combo: &str) -> Result<KeySpec, String> {
    let combo = combo.trim();
    if combo.is_empty() {
        return Err("No key given.".into());
    }
    let (mods_part, key_part) = if combo == "+" || !combo.contains('+') {
        ("", combo)
    } else if let Some(stripped) = combo.strip_suffix("++") {
        (stripped, "+")
    } else {
        combo.rsplit_once('+').ok_or("bad key")?
    };
    let mut modifiers = 0;
    for m in mods_part.split('+').filter(|m| !m.is_empty()) {
        modifiers |= match m.to_ascii_lowercase().as_str() {
            "alt" | "option" => MOD_ALT,
            "control" | "ctrl" => MOD_CTRL,
            "meta" | "cmd" | "command" | "super" | "win" => MOD_META,
            "shift" => MOD_SHIFT,
            other => return Err(format!("Unknown modifier {other:?} (use Control, Shift, Alt or Meta).")),
        };
    }
    let printing_allowed = modifiers & (MOD_CTRL | MOD_ALT | MOD_META) == 0;
    if let Some((key, code, key_code, text)) = named_key(key_part) {
        return Ok(KeySpec {
            key: key.into(),
            code: code.into(),
            key_code,
            text: text.filter(|_| printing_allowed).map(str::to_string),
            modifiers,
        });
    }
    let mut chars = key_part.chars();
    let (Some(c), None) = (chars.next(), chars.next()) else {
        return Err(format!("Unknown key {key_part:?}: use a key name (Enter, Tab, Escape, ArrowDown ...) or one character."));
    };
    let shifted = modifiers & MOD_SHIFT != 0;
    let ch = if shifted && c.is_ascii_lowercase() { c.to_ascii_uppercase() } else { c };
    let (code, key_code) = if c.is_ascii_alphabetic() {
        (format!("Key{}", c.to_ascii_uppercase()), c.to_ascii_uppercase() as u32)
    } else if c.is_ascii_digit() {
        (format!("Digit{c}"), c as u32)
    } else {
        (String::new(), 0)
    };
    Ok(KeySpec { key: ch.to_string(), code, key_code, text: printing_allowed.then(|| ch.to_string()), modifiers })
}

/// Modifier keys pressed before / released after the main key: (key, code, keyCode, bit).
pub fn modifier_keys(modifiers: u32) -> Vec<(&'static str, &'static str, u32, u32)> {
    let all = [
        ("Control", "ControlLeft", 17, MOD_CTRL),
        ("Shift", "ShiftLeft", 16, MOD_SHIFT),
        ("Alt", "AltLeft", 18, MOD_ALT),
        ("Meta", "MetaLeft", 91, MOD_META),
    ];
    all.into_iter().filter(|(_, _, _, bit)| modifiers & bit != 0).collect()
}

/// JSON value as short text for tool results (strings unquoted), capped.
pub fn value_text(v: &Value, max: usize) -> String {
    let s = match v {
        Value::String(s) => s.clone(),
        Value::Null => "undefined / null".to_string(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    };
    if s.len() > max {
        let mut cut = max;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}\n… ({} more characters)", &s[..cut], s.len() - cut)
    } else {
        s
    }
}
