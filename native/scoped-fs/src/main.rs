use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{self, BufRead, Write},
};
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
use windows as platform;

const MAX_REQUEST: usize = 65536;
const MAX_READ: usize = 8 * 1024 * 1024;
const MAX_RESPONSE: usize = 12 * 1024 * 1024;
type Result<T> = std::result::Result<T, &'static str>;
struct Request {
    version: u32,
    seq: u64,
    command: Command,
}
impl<'de> Deserialize<'de> for Request {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            version: u32,
            seq: u64,
            op: String,
            roots: Option<Vec<String>>,
            root: Option<String>,
            components: Option<Vec<String>>,
            #[serde(rename = "maxBytes")]
            max_bytes: Option<usize>,
            limit: Option<usize>,
        }
        let w = Wire::deserialize(deserializer)?;
        let bad = || serde::de::Error::custom("invalid request");
        let command = match w.op.as_str() {
            "hello"
                if w.roots.is_none()
                    && w.root.is_none()
                    && w.components.is_none()
                    && w.max_bytes.is_none()
                    && w.limit.is_none() =>
            {
                Command::Hello
            }
            "init"
                if w.root.is_none()
                    && w.components.is_none()
                    && w.max_bytes.is_none()
                    && w.limit.is_none() =>
            {
                Command::Init {
                    roots: w.roots.ok_or_else(bad)?,
                }
            }
            "read" if w.roots.is_none() && w.limit.is_none() => Command::Read {
                root: w.root.ok_or_else(bad)?,
                components: w.components.ok_or_else(bad)?,
                max_bytes: w.max_bytes.ok_or_else(bad)?,
            },
            "list" if w.roots.is_none() && w.max_bytes.is_none() => Command::List {
                root: w.root.ok_or_else(bad)?,
                components: w.components.ok_or_else(bad)?,
                limit: w.limit.ok_or_else(bad)?,
            },
            "close"
                if w.roots.is_none()
                    && w.components.is_none()
                    && w.max_bytes.is_none()
                    && w.limit.is_none() =>
            {
                Command::Close {
                    root: w.root.ok_or_else(bad)?,
                }
            }
            _ => return Err(bad()),
        };
        Ok(Self {
            version: w.version,
            seq: w.seq,
            command,
        })
    }
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Command {
    Hello,
    Init {
        roots: Vec<String>,
    },
    Read {
        root: String,
        components: Vec<String>,
        #[serde(rename = "maxBytes")]
        max_bytes: usize,
    },
    List {
        root: String,
        components: Vec<String>,
        limit: usize,
    },
    Close {
        root: String,
    },
}
#[derive(Serialize)]
struct Entry {
    name: String,
    kind: &'static str,
    size: u64,
}
#[derive(Serialize)]
struct Listing {
    entries: Vec<Entry>,
    truncated: bool,
}
fn component(s: &str) -> Result<()> {
    if s.is_empty()
        || s == "."
        || s == ".."
        || s.len() > 255
        || s.chars()
            .any(|c| c.is_control() || "\\/:<>\"|?*".contains(c))
        || s.ends_with(['.', ' '])
    {
        return Err("INVALID_COMPONENT");
    }
    let stem = s.split('.').next().unwrap().to_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(
                &stem[3..],
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            ))
    {
        return Err("INVALID_COMPONENT");
    }
    Ok(())
}
fn components(parts: &[String]) -> Result<()> {
    if parts.len() > 256 {
        return Err("INVALID_COMPONENT");
    }
    parts.iter().try_for_each(|p| component(p))
}
#[derive(Default)]
struct State {
    initialized: bool,
    seq: u64,
    roots: HashMap<String, platform::Root>,
}
impl State {
    fn execute(&mut self, req: Request) -> Result<Value> {
        if req.version != 1 {
            return Err("UNSUPPORTED_VERSION");
        }
        if req.seq <= self.seq || req.seq > 9_007_199_254_740_991 {
            return Err("INVALID_SEQUENCE");
        }
        self.seq = req.seq;
        match req.command {
            Command::Hello => Ok(
                json!({"protocolVersion":1,"capabilities":["read","list"],"maxRequestBytes":MAX_REQUEST,"maxReadBytes":MAX_READ,"maxListEntries":1000}),
            ),
            Command::Init { roots } => {
                if self.initialized {
                    return Err("ALREADY_INITIALIZED");
                }
                // A failed init also consumes the one-time setup authority.
                self.initialized = true;
                if roots.len() > 16 {
                    return Err("TOO_MANY_ROOTS");
                }
                let mut opened = HashMap::new();
                let mut tokens = Vec::new();
                for path in roots {
                    let root = platform::Root::open(&path)?;
                    let mut bytes = [0u8; 32];
                    getrandom::fill(&mut bytes).map_err(|_| "RANDOM_FAILED")?;
                    let token = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
                    if opened.contains_key(&token) {
                        return Err("RANDOM_FAILED");
                    }
                    tokens.push(json!({"token":token}));
                    opened.insert(token, root);
                }
                self.roots = opened;
                Ok(json!({"roots":tokens}))
            }
            Command::Read {
                root,
                components: parts,
                max_bytes,
            } => {
                components(&parts)?;
                if max_bytes == 0 || max_bytes > MAX_READ {
                    return Err("INVALID_LIMIT");
                }
                let root = self.roots.get(&root).ok_or("UNKNOWN_ROOT")?;
                let data = root.read(&parts, max_bytes)?;
                Ok(json!({"bytes":data.len(),"dataBase64":STANDARD.encode(data)}))
            }
            Command::List {
                root,
                components: parts,
                limit,
            } => {
                components(&parts)?;
                if limit == 0 || limit > 1000 {
                    return Err("INVALID_LIMIT");
                }
                let root = self.roots.get(&root).ok_or("UNKNOWN_ROOT")?;
                serde_json::to_value(root.list(&parts, limit)?).map_err(|_| "INTERNAL")
            }
            Command::Close { root } => {
                self.roots.remove(&root).ok_or("UNKNOWN_ROOT")?;
                Ok(json!({}))
            }
        }
    }
}
fn error(seq: Option<u64>, code: &str) -> Value {
    json!({"version":1,"seq":seq,"ok":false,"error":{"code":code}})
}
// fill_buf is bounded; read_until alone would allocate unbounded memory on a hostile frame.
fn frame(
    input: &mut impl BufRead,
) -> io::Result<Option<std::result::Result<Vec<u8>, &'static str>>> {
    let mut data = Vec::new();
    let mut over = false;
    loop {
        let buf = input.fill_buf()?;
        if buf.is_empty() {
            return Ok(if data.is_empty() && !over {
                None
            } else {
                Some(Err("TRUNCATED_FRAME"))
            });
        }
        let newline = buf.iter().position(|&b| b == b'\n');
        let take = newline.unwrap_or(buf.len());
        if !over {
            if data.len() + take > MAX_REQUEST {
                over = true;
                data.clear();
            } else {
                data.extend_from_slice(&buf[..take]);
            }
        }
        input.consume(take + usize::from(newline.is_some()));
        if newline.is_some() {
            return Ok(Some(if over {
                Err("REQUEST_TOO_LARGE")
            } else {
                Ok(data)
            }));
        }
    }
}
fn run() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::BufWriter::new(io::stdout().lock());
    let mut state = State::default();
    while let Some(line) = frame(&mut input)? {
        let response = match line {
            Err(code) => error(None, code),
            Ok(bytes) => match serde_json::from_slice::<Request>(&bytes) {
                Err(_) => error(None, "INVALID_REQUEST"),
                Ok(req) => {
                    let seq = req.seq;
                    match state.execute(req) {
                        Ok(result) => json!({"version":1,"seq":seq,"ok":true,"result":result}),
                        Err(code) => error(Some(seq), code),
                    }
                }
            },
        };
        let mut encoded = serde_json::to_vec(&response)?;
        if encoded.len() > MAX_RESPONSE {
            encoded = serde_json::to_vec(&error(response["seq"].as_u64(), "RESPONSE_TOO_LARGE"))?;
        }
        output.write_all(&encoded)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}
fn main() {
    if run().is_err() {
        std::process::exit(1);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names() {
        for s in [
            "", ".", "..", "a/b", "a\\b", "a:b", "NUL.txt", "com1", "COM¹", "x.", "x ",
        ] {
            assert!(component(s).is_err(), "{s}");
        }
        assert!(component("normal.txt").is_ok());
    }
    #[test]
    fn frames() {
        let bytes = [vec![b'x'; MAX_REQUEST + 1], b"\n{}\n".to_vec()].concat();
        let mut c = io::Cursor::new(bytes);
        assert_eq!(frame(&mut c).unwrap().unwrap(), Err("REQUEST_TOO_LARGE"));
        assert_eq!(frame(&mut c).unwrap().unwrap().unwrap(), b"{}");
    }
    #[test]
    fn request_schema() {
        assert!(serde_json::from_str::<Request>(r#"{"version":1,"seq":1,"op":"hello"}"#).is_ok());
        assert!(
            serde_json::from_str::<Request>(r#"{"version":1,"seq":1,"op":"hello","extra":1}"#)
                .is_err()
        );
    }
}
