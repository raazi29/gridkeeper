//! Secret redaction for logs, errors and diagnostics.
//!
//! `redact()` is applied to every log line written to disk (see `logging`),
//! to error messages sent to the UI (see `types::AppError`) and to every
//! diagnostics bundle. It is deliberately aggressive: a false positive costs a
//! little debuggability, a false negative leaks a credential.
//!
//! All regexes are compiled once.

use once_cell::sync::Lazy;
use regex::{Captures, Regex};

/// Replacement marker. Contains no quotes or separators so masked JSON stays valid.
pub const MASK: &str = "[REDACTED]";

/// Key-name fragments that mark a value as secret (case-insensitive).
const SECRET_KEY_WORDS: &str =
    r"api[_-]?key|token|secret|password|passwd|authorization|cookie|credential|session[_-]?key|private[_-]?key";

static SECRET_KEY_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(&format!(r"(?i)(?:{SECRET_KEY_WORDS})")).expect("secret key regex"));

/// Anthropic keys / OAuth tokens: sk-ant-api03-..., sk-ant-oat01-...
static ANTHROPIC_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"sk-ant-[A-Za-z0-9_\-]{8,}").expect("anthropic regex"));

/// OpenAI style keys: sk-..., sk-proj-..., sk-svcacct-...
static OPENAI_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bsk-[A-Za-z0-9_\-]{16,}").expect("openai regex"));

/// `Bearer <token>` (HTTP Authorization header values).
static BEARER_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\b(bearer)\s+[A-Za-z0-9\-._~+/]{8,}=*").expect("bearer regex"));

/// GitHub tokens.
static GITHUB_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})").expect("github regex")
});

/// AWS access key ids.
static AWS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b").expect("aws regex"));

/// JSON Web Tokens (header.payload.signature, both JSON parts base64url `{"`).
static JWT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\beyJ[A-Za-z0-9_\-]{5,}\.eyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}").expect("jwt regex")
});

/// `key=value`, `key: value`, `"key": "value"`, `KEY='value'`, and the same inside
/// an escaped JSON string (`\"key\":\"value\"`), where the key name contains a secret word.
static KEY_VALUE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r#"(?i)(?P<pre>[A-Za-z0-9_.\-]*(?:{SECRET_KEY_WORDS})[A-Za-z0-9_.\-]*(?:\\?["'])?\s*[:=]\s*)(?P<val>\\".*?\\"|"(?:[^"\\]|\\.)*"|'[^']*'|(?:(?:bearer|basic|token)\s+)?[^\s"'\\,;&}}\])]+)"#
    ))
    .expect("key/value regex")
});

/// Command-line flags: `--api-key VALUE`, `--token VALUE`, `-password VALUE`.
static FLAG_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r#"(?i)(?P<pre>(?:^|\s)--?[A-Za-z0-9_\-]*(?:{SECRET_KEY_WORDS})[A-Za-z0-9_\-]*\s+)(?P<val>"[^"]*"|'[^']*'|[^\s\-"'][^\s"']*)"#
    ))
    .expect("flag regex")
});

/// True when an environment-variable / JSON key name looks like it holds a secret.
pub fn is_secret_key(key: &str) -> bool {
    SECRET_KEY_RE.is_match(key)
}

fn mask_value(val: &str) -> String {
    if val.contains("REDACTED") {
        return val.to_string();
    }
    if val.starts_with("\\\"") {
        format!("\\\"{MASK}\\\"")
    } else if val.starts_with('"') {
        format!("\"{MASK}\"")
    } else if val.starts_with('\'') {
        format!("'{MASK}'")
    } else {
        MASK.to_string()
    }
}

/// Mask anything that looks like a secret. Never panics; returns the input
/// unchanged (as an owned string) when nothing matches.
pub fn redact(input: &str) -> String {
    // Specific token shapes first, so a key/value pass can never leave half a token behind.
    let s = ANTHROPIC_RE.replace_all(input, format!("sk-ant-{MASK}").as_str());
    let s = OPENAI_RE.replace_all(&s, format!("sk-{MASK}").as_str());
    let s = BEARER_RE.replace_all(&s, |c: &Captures| format!("{} {MASK}", &c[1]));
    let s = GITHUB_RE.replace_all(&s, MASK);
    let s = AWS_RE.replace_all(&s, MASK);
    let s = JWT_RE.replace_all(&s, MASK);
    let s = KEY_VALUE_RE.replace_all(&s, |c: &Captures| format!("{}{}", &c["pre"], mask_value(&c["val"])));
    let s = FLAG_RE.replace_all(&s, |c: &Captures| format!("{}{}", &c["pre"], mask_value(&c["val"])));
    s.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaks(out: &str, secret: &str) -> bool {
        out.contains(secret)
    }

    #[test]
    fn plain_text_unchanged() {
        let s = "session 42 started in D:\\work with 3 panes";
        assert_eq!(redact(s), s);
        assert_eq!(redact(""), "");
    }

    #[test]
    fn anthropic_and_openai_keys() {
        let a = "key sk-ant-api03-AbCdEf0123456789_xyz-QQ end";
        let out = redact(a);
        assert!(!leaks(&out, "AbCdEf0123456789"), "{out}");
        assert!(out.contains("sk-ant-[REDACTED]"));
        let o = "using sk-proj-abcdefghijklmnopqrstuvwxyz012345 now";
        let out = redact(o);
        assert!(!leaks(&out, "abcdefghijklmnop"), "{out}");
        assert!(out.ends_with(" now"));
    }

    #[test]
    fn bearer_tokens() {
        let out = redact("Authorization: Bearer abc.def-ghi_jkl012345");
        assert!(!leaks(&out, "abc.def-ghi_jkl012345"), "{out}");
        let out = redact("header bearer QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
        assert!(!leaks(&out, "QWxhZGRpbjpvcGVuIHNlc2FtZQ"), "{out}");
        let out = redact("authorization: Basic QWxhZGRpbjpvcGVu");
        assert!(!leaks(&out, "QWxhZGRpbjpvcGVu"), "{out}");
        assert_eq!(redact("a basic configuration"), "a basic configuration");
    }

    #[test]
    fn key_value_forms() {
        for (input, secret) in [
            ("ANTHROPIC_API_KEY=hunter2hunter2", "hunter2hunter2"),
            ("password: s3cr3t!", "s3cr3t!"),
            ("db_passwd = 'open sesame'", "open sesame"),
            ("Cookie: sid=abcdef123", "abcdef123"),
            ("CLAUDE_CODE_OAUTH_TOKEN=\"tok with spaces\"", "tok with spaces"),
            ("session_key=0123456789abcdef", "0123456789abcdef"),
            ("client-secret:xyzzy", "xyzzy"),
        ] {
            let out = redact(input);
            assert!(!leaks(&out, secret), "{input} -> {out}");
            assert!(out.contains(MASK), "{input} -> {out}");
        }
    }

    #[test]
    fn json_forms_stay_valid() {
        let input = r#"{"apiKey": "abc123secret", "name": "ok", "authToken":"t0k3n", "n": 5}"#;
        let out = redact(input);
        assert!(!leaks(&out, "abc123secret") && !leaks(&out, "t0k3n"), "{out}");
        let v: serde_json::Value = serde_json::from_str(&out).expect("still valid JSON");
        assert_eq!(v["name"], "ok");
        assert_eq!(v["apiKey"], MASK);

        // A JSON document embedded in a JSON string (as in a log line's message field).
        let line = serde_json::json!({ "message": r#"cfg {"api_key":"zzz-secret-zzz","x":1}"# }).to_string();
        let out = redact(&line);
        assert!(!leaks(&out, "zzz-secret-zzz"), "{out}");
        serde_json::from_str::<serde_json::Value>(&out).expect("log line still valid JSON");
    }

    #[test]
    fn provider_token_shapes() {
        for secret in [
            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
            "AKIAIOSFODNN7EXAMPLE",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        ] {
            let out = redact(&format!("value {secret} here"));
            assert!(!leaks(&out, secret), "{secret} -> {out}");
            assert!(out.starts_with("value ") && out.ends_with(" here"), "{out}");
        }
    }

    #[test]
    fn cli_flags() {
        let out = redact("claude --api-key abcdef123456 --verbose");
        assert!(!leaks(&out, "abcdef123456"), "{out}");
        assert!(out.contains("--verbose"));
    }

    #[test]
    fn idempotent() {
        let once = redact("token=abc password=\"x y\" sk-ant-api03-0123456789abcdef");
        assert_eq!(redact(&once), once);
    }

    #[test]
    fn secret_key_detection() {
        assert!(is_secret_key("ANTHROPIC_API_KEY"));
        assert!(is_secret_key("GITHUB_TOKEN"));
        assert!(is_secret_key("my-password"));
        assert!(is_secret_key("AWS_SECRET_ACCESS_KEY"));
        assert!(!is_secret_key("TERM"));
        assert!(!is_secret_key("CLAUDE_CONFIG_DIR"));
        assert!(!is_secret_key("PATH"));
    }
}
