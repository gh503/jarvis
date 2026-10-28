# Scoped filesystem helper, protocol version 1

Standalone Rust executable `jarvis-scoped-fs`, pinned to Rust 1.94.0. The trusted parent launches it as the ordinary user, keeps stdin/stdout private, and sends exactly one `init` with explicit absolute roots. No roots, writes, execution, network operations, or elevation are implicitly granted. Packaging/integration belongs to the parent application.

## Wire protocol

UTF-8 newline-delimited JSON on stdin/stdout only. Maximum request: 65,536 bytes excluding newline. Maximum serialized response: 12 MiB excluding newline. Oversize frames are drained with bounded memory and rejected. EOF inside a frame produces `TRUNCATED_FRAME`. No input values or OS error messages are included in errors. Each request has `version:1`, `seq` (strictly increasing integer, 1 through 9007199254740991), and `op`. Unknown fields and operations are rejected. Invalid JSON/schema errors have `seq:null`; otherwise errors echo the request sequence. Recognized, version-valid requests consume their sequence even when the operation fails.

Success: `{"version":1,"seq":1,"ok":true,"result":{...}}`.
Error: `{"version":1,"seq":1,"ok":false,"error":{"code":"OPEN_DENIED"}}`.

Operations (fields below are in addition to version, seq, op):

- `hello`: no additional fields. Result `{protocolVersion:1,capabilities:["read","list"],maxRequestBytes:65536,maxReadBytes:8388608,maxListEntries:1000}`.
- `init`: `roots:string[]`, maximum 16, exactly once including failed attempts. All roots are opened atomically as a group; any failure grants none. Result `{roots:[{token:string},...]}` in input order. Tokens are 32 OS-random bytes encoded as 64 lowercase hex characters. Empty roots are allowed. There is no register operation.
- `read`: `root:string` token, `components:string[]`, `maxBytes:integer` from 1 through 8388608. Result `{dataBase64:string,bytes:number}`. Reads whole regular single-link files, rejects oversize files rather than truncating, and checks metadata after the read.
- `list`: `root:string` token, `components:string[]`, `limit:integer` from 1 through 1000. Result `{entries:[{name:string,kind:"file"|"directory"|"other",size:number},...],truncated:boolean}`. Enumeration order is native and unspecified; no pagination or stable snapshot is promised. Metadata does not follow links. Links/reparse points appear as `other`. Unrepresentable names fail with `UNSUPPORTED_NAME`. Sizes are native logical sizes, with negative values clamped to zero.
- `close`: `root:string` token. Result `{}`; token immediately becomes unusable. EOF terminates the helper and revokes all remaining tokens.

Empty component arrays address the registered root itself (valid for list, not regular-file read). Maximum 256 components; each must be nonempty, at most 255 UTF-8 bytes, not `.` or `..`, contain no controls, slash, backslash, colon, Windows wildcard/metacharacters, or trailing space/dot. DOS device aliases (including extension and superscript-number variants) are rejected on all platforms. Windows additionally limits components to 255 UTF-16 units. Absolute Unix roots use `/`; Windows roots must use drive-absolute `C:\\...` spelling with backslash separators. Except a filesystem root, trailing separators and empty components are rejected.

Error codes: `INVALID_REQUEST`, `TRUNCATED_FRAME`, `REQUEST_TOO_LARGE`, `RESPONSE_TOO_LARGE`, `UNSUPPORTED_VERSION`, `INVALID_SEQUENCE`, `ALREADY_INITIALIZED`, `TOO_MANY_ROOTS`, `RANDOM_FAILED`, `INVALID_ROOT`, `INVALID_COMPONENT`, `INVALID_LIMIT`, `UNKNOWN_ROOT`, `OPEN_DENIED`, `METADATA_FAILED`, `NOT_REGULAR_FILE`, `NOT_DIRECTORY`, `HARD_LINK_DENIED`, `FILE_TOO_LARGE`, `READ_FAILED`, `LIST_FAILED`, `UNSUPPORTED_NAME`, `UNSUPPORTED_VOLUME`, `CROSS_DEVICE_DENIED`, `REPARSE_DENIED`, `STALE_FILE`, `INTERNAL`.

Windows open failures additionally identify their stage using static codes: `OPEN_ROOT_ACCESS_DENIED`, `OPEN_ROOT_SHARING_VIOLATION`, `OPEN_ROOT_INVALID_PARAMETER`, `OPEN_ROOT_NOT_FOUND`, `OPEN_ROOT_INVALID_NAME`, `OPEN_ROOT_DENIED`; or `OPEN_COMPONENT_ACCESS_DENIED`, `OPEN_COMPONENT_SHARING_VIOLATION`, `OPEN_COMPONENT_INVALID_PARAMETER`, `OPEN_COMPONENT_NOT_FOUND`, `OPEN_COMPONENT_PATH_NOT_FOUND`, `OPEN_COMPONENT_NOT_DIRECTORY`, `OPEN_COMPONENT_IS_DIRECTORY`, `OPEN_COMPONENT_INVALID_NAME`, `OPEN_COMPONENT_DENIED`. These codes never contain paths or input contents.

## Authority and platform boundaries

Authority belongs to opened directory objects, **not current pathname containment**. Renaming an authorized directory does not revoke its authority; a replacement at the old path does not acquire authority. The helper is not a defense against a malicious same-user process, a hostile kernel/filesystem, or arbitrary mount administration. Metadata stability checks detect ordinary concurrent changes but cannot guarantee atomic snapshots or prevent same-size concurrent writes with indistinguishable timestamps. The trusted parent must not expose `init` or raw helper stdin to untrusted callers.

Unix uses `openat` with `O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK`, and `O_DIRECTORY` for intermediate components. Reads reject nonregular and multilink files. Traversal rejects device-ID changes relative to the root; same-device bind mounts are not detected. Root registration rejects `/dev` and Linux pseudo-filesystems including procfs/sysfs/debugfs/devpts/securityfs/cgroup. Registration walks every absolute component without following symlinks. On macOS, a trusted parent may need to canonicalize its chosen path first (e.g. `/var` aliases) before granting the resulting explicit root.

Windows opens only a local disk NTFS drive anchor with `CreateFileW`, then uses `NtCreateFile` with `RootDirectory`, one component per call, `FILE_OPEN_REPARSE_POINT`, synchronous handles, and no `FILE_SHARE_DELETE`. Every opened object is checked for reparse attributes; all ancestors are retained throughout the operation, and root ancestors for the token lifetime. UNC, device paths, mapped remote volumes, non-NTFS volumes, streams and DOS aliases are rejected. Directory enumeration uses `NtQueryDirectoryFile` with a reset scan cursor for each synchronous list request; empty-component enumeration borrows the registered root handle directly. All handles have RAII ownership. MSVC x64 and ARM64 release builds select the static CRT via local Cargo configuration; build from this crate directory so Cargo discovers it.

## Validation and licensing

Run `cargo test --locked` and `cargo build --release --locked` from this directory. Linux process tests cover framing, sequences, init-once, token revocation, read/list bounds, root rename authority, symlink and hard-link denial, FIFO rejection and invalid names. Windows/macOS require native CI execution in addition to cross-target `cargo check`.

This crate is GPL-3.0-or-later. Dependencies are pinned in Cargo.lock and use GPL-compatible MIT/Apache-2.0/BSD-style licenses. The parent packaging script inventories and copies dependency license texts into the distributable; see the repository license and generated distribution notices. No dynamic Python runtime is used.
