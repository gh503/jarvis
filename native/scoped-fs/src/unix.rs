use crate::{Entry, Listing, Result};
use std::{
    ffi::{CStr, CString},
    fs::File,
    io::Read,
    os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
};
pub struct Root(OwnedFd);
fn cstr(s: &str) -> Result<CString> {
    CString::new(s).map_err(|_| "INVALID_COMPONENT")
}
fn open_at(fd: RawFd, name: &str, directory: bool) -> Result<OwnedFd> {
    let name = cstr(name)?;
    let flags = libc::O_RDONLY
        | libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    let raw = unsafe { libc::openat(fd, name.as_ptr(), flags) };
    if raw < 0 {
        return Err("OPEN_DENIED");
    }
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}
fn stat(fd: RawFd) -> Result<libc::stat> {
    let mut s = std::mem::MaybeUninit::uninit();
    if unsafe { libc::fstat(fd, s.as_mut_ptr()) } != 0 {
        return Err("METADATA_FAILED");
    }
    Ok(unsafe { s.assume_init() })
}
fn regular(s: &libc::stat) -> Result<()> {
    if s.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err("NOT_REGULAR_FILE");
    }
    if s.st_nlink != 1 {
        return Err("HARD_LINK_DENIED");
    }
    Ok(())
}
impl Root {
    pub fn open(path: &str) -> Result<Self> {
        if !path.starts_with('/') || path.starts_with("//") {
            return Err("INVALID_ROOT");
        }
        let mut fd = open_at(libc::AT_FDCWD, "/", true)?;
        if path != "/" {
            for p in path[1..].split('/') {
                crate::component(p)?;
                fd = open_at(fd.as_raw_fd(), p, true)?;
            }
        }
        #[cfg(target_os = "linux")]
        {
            let mut fs = std::mem::MaybeUninit::<libc::statfs>::uninit();
            if unsafe { libc::fstatfs(fd.as_raw_fd(), fs.as_mut_ptr()) } != 0 {
                return Err("METADATA_FAILED");
            }
            let kind = unsafe { fs.assume_init() }.f_type;
            if matches!(
                kind,
                0x9fa0 | 0x62656572 | 0x64626720 | 0x1cd1 | 0x73636673 | 0x27e0eb
            ) {
                return Err("UNSUPPORTED_VOLUME");
            }
        }
        // Device directories are never useful read capabilities.
        if path == "/dev" || path.starts_with("/dev/") {
            return Err("UNSUPPORTED_VOLUME");
        }
        Ok(Self(fd))
    }
    fn descend(&self, parts: &[String], directory: bool) -> Result<OwnedFd> {
        let mut fd = open_at(self.0.as_raw_fd(), ".", true)?;
        let device = stat(self.0.as_raw_fd())?.st_dev;
        for (i, p) in parts.iter().enumerate() {
            fd = open_at(fd.as_raw_fd(), p, directory || i + 1 < parts.len())?;
            if stat(fd.as_raw_fd())?.st_dev != device {
                return Err("CROSS_DEVICE_DENIED");
            }
        }
        Ok(fd)
    }
    pub fn read(&self, parts: &[String], limit: usize) -> Result<Vec<u8>> {
        let fd = self.descend(parts, false)?;
        let before = stat(fd.as_raw_fd())?;
        regular(&before)?;
        if before.st_size < 0 || before.st_size as u64 > limit as u64 {
            return Err("FILE_TOO_LARGE");
        }
        let mut file = File::from(fd);
        let mut bytes = Vec::new();
        (&mut file)
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "READ_FAILED")?;
        let after = stat(file.as_raw_fd())?;
        regular(&after)?;
        if bytes.len() > limit || after.st_size < 0 || after.st_size as u64 > limit as u64 {
            return Err("FILE_TOO_LARGE");
        }
        if before.st_size != after.st_size
            || before.st_mtime != after.st_mtime
            || before.st_mtime_nsec != after.st_mtime_nsec
            || before.st_ctime != after.st_ctime
            || before.st_ctime_nsec != after.st_ctime_nsec
            || bytes.len() as u64 != after.st_size as u64
        {
            return Err("STALE_FILE");
        }
        Ok(bytes)
    }
    pub fn list(&self, parts: &[String], limit: usize) -> Result<Listing> {
        let fd = self.descend(parts, true)?;
        // fdopendir takes ownership only on success.
        let raw = fd.as_raw_fd();
        let ptr = unsafe { libc::fdopendir(raw) };
        if ptr.is_null() {
            return Err("LIST_FAILED");
        }
        std::mem::forget(fd);
        struct Dir(*mut libc::DIR);
        impl Drop for Dir {
            fn drop(&mut self) {
                unsafe {
                    libc::closedir(self.0);
                }
            }
        }
        let dir = Dir(ptr);
        let mut entries = Vec::new();
        let mut truncated = false;
        loop {
            set_errno_zero();
            let item = unsafe { libc::readdir(dir.0) };
            if item.is_null() {
                if errno() != 0 {
                    return Err("LIST_FAILED");
                }
                break;
            }
            let name = unsafe { CStr::from_ptr((*item).d_name.as_ptr()) };
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            if entries.len() == limit {
                truncated = true;
                break;
            }
            // Non-UTF8 names cannot round-trip through this protocol: fail closed.
            let text = name.to_str().map_err(|_| "UNSUPPORTED_NAME")?;
            crate::component(text).map_err(|_| "UNSUPPORTED_NAME")?;
            let mut s = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe {
                libc::fstatat(
                    raw,
                    name.as_ptr(),
                    s.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                return Err("METADATA_FAILED");
            }
            let s = unsafe { s.assume_init() };
            let kind = match s.st_mode & libc::S_IFMT {
                libc::S_IFREG => "file",
                libc::S_IFDIR => "directory",
                _ => "other",
            };
            entries.push(Entry {
                name: text.into(),
                kind,
                size: s.st_size.max(0) as u64,
            });
        }
        Ok(Listing { entries, truncated })
    }
}
#[cfg(target_os = "linux")]
fn errno_ptr() -> *mut i32 {
    unsafe { libc::__errno_location() }
}
#[cfg(target_os = "macos")]
fn errno_ptr() -> *mut i32 {
    unsafe { libc::__error() }
}
fn set_errno_zero() {
    unsafe {
        *errno_ptr() = 0;
    }
}
fn errno() -> i32 {
    unsafe { *errno_ptr() }
}
