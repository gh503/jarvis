use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};
struct Helper {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    seq: u64,
}
impl Helper {
    fn new() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_jarvis-scoped-fs"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            input,
            output,
            seq: 0,
        }
    }
    fn raw(&mut self, line: &str) -> Value {
        self.input.write_all(line.as_bytes()).unwrap();
        self.input.write_all(b"\n").unwrap();
        self.input.flush().unwrap();
        let mut s = String::new();
        self.output.read_line(&mut s).unwrap();
        serde_json::from_str(&s).unwrap()
    }
    fn call(&mut self, mut v: Value) -> Value {
        self.seq += 1;
        v["version"] = json!(1);
        v["seq"] = json!(self.seq);
        self.raw(&v.to_string())
    }
}
impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
#[test]
fn protocol_bounds_and_sequence() {
    let mut h = Helper::new();
    assert_eq!(
        h.call(json!({"op":"hello"}))["result"]["capabilities"],
        json!(["read", "list"])
    );
    assert_eq!(
        h.raw(r#"{"version":1,"seq":1,"op":"hello"}"#)["error"]["code"],
        "INVALID_SEQUENCE"
    );
    assert_eq!(
        h.raw(&"x".repeat(65537))["error"]["code"],
        "REQUEST_TOO_LARGE"
    );
    assert_eq!(
        h.call(json!({"op":"hello","unexpected":true}))["error"]["code"],
        "INVALID_REQUEST"
    );
    assert_eq!(h.call(json!({"op":"hello"}))["ok"], true);
    assert_eq!(h.call(json!({"op":"init","roots":[]}))["ok"], true);
    assert_eq!(
        h.call(json!({"op":"init","roots":[]}))["error"]["code"],
        "ALREADY_INITIALIZED"
    );
}
#[cfg(unix)]
#[test]
fn object_authority_and_link_rejection() {
    use std::{fs, os::unix::fs::symlink};
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).unwrap();
    let tag = random
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let base = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("scoped-fs-test-{tag}"));
    fs::create_dir(&base).unwrap();
    struct Temp(std::path::PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            assert!(
                self.0
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("scoped-fs-test-")
            );
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Temp(base.clone());
    let root = base.join("root");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("safe"), b"hello").unwrap();
    fs::write(base.join("outside"), b"secret").unwrap();
    symlink(base.join("outside"), root.join("link")).unwrap();
    symlink(&base, root.join("dirlink")).unwrap();
    fs::hard_link(base.join("outside"), root.join("hard")).unwrap();
    let fifo = std::ffi::CString::new(root.join("fifo").to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let mut h = Helper::new();
    let init = h.call(json!({"op":"init","roots":[root]}));
    assert_eq!(init["ok"], true);
    let token = init["result"]["roots"][0]["token"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(token.len(), 64);
    let read =
        |name: &str, max| json!({"op":"read","root":token,"components":[name],"maxBytes":max});
    assert_eq!(h.call(read("safe", 5))["result"]["dataBase64"], "aGVsbG8=");
    assert_eq!(h.call(read("safe", 4))["error"]["code"], "FILE_TOO_LARGE");
    for name in ["link", "hard", "fifo", "..", "a/b", "NUL"] {
        assert_eq!(h.call(read(name, 100))["ok"], false, "{name}");
    }
    assert_eq!(
        h.call(json!({"op":"read","root":token,"components":["dirlink","outside"],"maxBytes":100}))
            ["ok"],
        false
    );
    let list = h.call(json!({"op":"list","root":token,"components":[],"limit":1}));
    assert_eq!(list["result"]["entries"].as_array().unwrap().len(), 1);
    assert_eq!(list["result"]["truncated"], true);
    assert_eq!(
        h.call(read("safe", 8388609))["error"]["code"],
        "INVALID_LIMIT"
    );
    // Renaming the registered object does not redirect its authority to a replacement path.
    fs::rename(&root, base.join("moved")).unwrap();
    fs::create_dir(&root).unwrap();
    fs::write(root.join("safe"), b"replacement").unwrap();
    assert_eq!(h.call(read("safe", 5))["result"]["dataBase64"], "aGVsbG8=");
    assert_eq!(h.call(json!({"op":"close","root":token}))["ok"], true);
    assert_eq!(h.call(read("safe", 100))["error"]["code"], "UNKNOWN_ROOT");
    let mut h = Helper::new();
    symlink(base.join("moved"), base.join("alias")).unwrap();
    assert_eq!(
        h.call(json!({"op":"init","roots":[base.join("alias")]}))["ok"],
        false
    );
}
