//! NT handle-relative opens. No validated path is reopened by name.
use crate::{Entry, Listing, Result};
use std::{
    ffi::c_void,
    fs::File,
    io::Read,
    os::windows::io::FromRawHandle,
    ptr::{null, null_mut},
};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}
#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root: HANDLE,
    name: *mut UnicodeString,
    attributes: u32,
    security: *mut c_void,
    quality: *mut c_void,
}
#[repr(C)]
struct IoStatus {
    status: usize,
    information: usize,
}
#[repr(C)]
#[derive(Default)]
struct FileTime {
    low: u32,
    high: u32,
}
#[repr(C)]
#[derive(Default)]
struct FileInfo {
    attributes: u32,
    creation: FileTime,
    access: FileTime,
    write: FileTime,
    volume: u32,
    size_high: u32,
    size_low: u32,
    links: u32,
    index_high: u32,
    index_low: u32,
}
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQueryVolumeInformationFile(
        handle: HANDLE,
        status: *mut IoStatus,
        buffer: *mut c_void,
        length: u32,
        class: u32,
    ) -> i32;
    fn NtCreateFile(
        handle: *mut HANDLE,
        access: u32,
        attributes: *mut ObjectAttributes,
        status: *mut IoStatus,
        allocation: *const i64,
        file_attributes: u32,
        share: u32,
        disposition: u32,
        options: u32,
        ea: *const c_void,
        ea_length: u32,
    ) -> i32;
    fn NtQueryDirectoryFile(
        handle: HANDLE,
        event: HANDLE,
        apc: *const c_void,
        context: *const c_void,
        status: *mut IoStatus,
        buffer: *mut c_void,
        length: u32,
        class: u32,
        single: u8,
        name: *const UnicodeString,
        restart: u8,
    ) -> i32;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn ReOpenFile(original: HANDLE, access: u32, share: u32, flags: u32) -> HANDLE;
    fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        security: *const c_void,
        disposition: u32,
        flags: u32,
        template: HANDLE,
    ) -> HANDLE;
    fn GetFileInformationByHandle(handle: HANDLE, info: *mut FileInfo) -> i32;
    fn GetVolumeInformationByHandleW(
        handle: HANDLE,
        volume: *mut u16,
        volume_len: u32,
        serial: *mut u32,
        max_component: *mut u32,
        flags: *mut u32,
        filesystem: *mut u16,
        filesystem_len: u32,
    ) -> i32;
    fn GetFileType(handle: HANDLE) -> u32;

}
struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn info(h: &Handle) -> Result<FileInfo> {
    let mut i = FileInfo::default();
    if unsafe { GetFileType(h.0) } != 1 || unsafe { GetFileInformationByHandle(h.0, &mut i) } == 0 {
        return Err("METADATA_FAILED");
    }
    if i.attributes & 0x400 != 0 {
        return Err("REPARSE_DENIED");
    }
    Ok(i)
}
fn open_at(parent: &Handle, name: &str, directory: bool) -> Result<Handle> {
    let mut wide: Vec<u16> = name.encode_utf16().collect();
    if wide.len() > 255 {
        return Err("INVALID_COMPONENT");
    }
    let mut us = UnicodeString {
        length: (wide.len() * 2) as u16,
        maximum_length: (wide.len() * 2) as u16,
        buffer: wide.as_mut_ptr(),
    };
    let mut oa = ObjectAttributes {
        length: std::mem::size_of::<ObjectAttributes>() as u32,
        root: parent.0,
        name: &mut us,
        attributes: 0x40,
        security: null_mut(),
        quality: null_mut(),
    };
    let mut ios = IoStatus {
        status: 0,
        information: 0,
    };
    let mut handle = null_mut();
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            0x100081,
            &mut oa,
            &mut ios,
            null(),
            0,
            3,
            1,
            0x200020 | if directory { 1 } else { 0x40 },
            null(),
            0,
        )
    };
    if status < 0 {
        return Err("OPEN_DENIED");
    }
    let h = Handle(handle);
    let i = info(&h)?;
    if directory && i.attributes & 0x10 == 0 {
        return Err("NOT_DIRECTORY");
    }
    Ok(h)
}
pub struct Root {
    ancestors: Vec<Handle>,
}
impl Root {
    pub fn open(path: &str) -> Result<Self> {
        let b = path.as_bytes();
        // Only DOS drive absolute local paths; never UNC, device namespaces or ADS.
        if b.len() < 3
            || !b[0].is_ascii_alphabetic()
            || b[1] != b':'
            || b[2] != b'\\'
            || path.contains('/')
        {
            return Err("INVALID_ROOT");
        }
        let anchor = format!("\\\\?\\{}:\\", b[0] as char);
        let wide: Vec<u16> = anchor.encode_utf16().chain(Some(0)).collect();
        let raw = unsafe {
            CreateFileW(
                wide.as_ptr(),
                0x100081,
                3,
                null(),
                3,
                0x02200000,
                null_mut(),
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            return Err("OPEN_DENIED");
        }
        let anchor = Handle(raw);
        info(&anchor)?;
        // FileFsDeviceInformation: reject remote and non-disk devices by handle,
        // so a mapped network drive cannot bypass the local-volume requirement.
        let mut device = [0u32; 2];
        let mut ios = IoStatus {
            status: 0,
            information: 0,
        };
        if unsafe {
            NtQueryVolumeInformationFile(anchor.0, &mut ios, device.as_mut_ptr().cast(), 8, 4)
        } < 0
            || device[0] != 7
            || device[1] & 0x10 != 0
        {
            return Err("UNSUPPORTED_VOLUME");
        }
        let mut fs = [0u16; 32];
        if unsafe {
            GetVolumeInformationByHandleW(
                anchor.0,
                null_mut(),
                0,
                null_mut(),
                null_mut(),
                null_mut(),
                fs.as_mut_ptr(),
                fs.len() as u32,
            )
        } == 0
        {
            return Err("UNSUPPORTED_VOLUME");
        }
        let n = fs.iter().position(|&v| v == 0).unwrap_or(fs.len());
        if String::from_utf16(&fs[..n]).map_err(|_| "UNSUPPORTED_VOLUME")? != "NTFS" {
            return Err("UNSUPPORTED_VOLUME");
        }
        let mut ancestors = vec![anchor];
        if b.len() > 3 {
            for p in path[3..].split('\\') {
                crate::component(p)?;
                let h = open_at(ancestors.last().unwrap(), p, true)?;
                ancestors.push(h);
            }
        }
        Ok(Self { ancestors })
    }
    fn descend(&self, parts: &[String], directory: bool) -> Result<Vec<Handle>> {
        let mut handles = Vec::new();
        // Reopen by HANDLE for an independent enumeration position, never by path.
        if parts.is_empty() {
            let raw =
                unsafe { ReOpenFile(self.ancestors.last().unwrap().0, 0x100081, 3, 0x02200000) };
            if raw == INVALID_HANDLE_VALUE {
                return Err("OPEN_DENIED");
            }
            let h = Handle(raw);
            info(&h)?;
            handles.push(h);
        }
        for (i, p) in parts.iter().enumerate() {
            let parent = handles
                .last()
                .unwrap_or_else(|| self.ancestors.last().unwrap());
            handles.push(open_at(parent, p, directory || i + 1 < parts.len())?);
        }
        Ok(handles)
    }
    pub fn read(&self, parts: &[String], limit: usize) -> Result<Vec<u8>> {
        if parts.is_empty() {
            return Err("NOT_REGULAR_FILE");
        }
        let mut ancestors = self.descend(parts, false)?;
        let h = ancestors.pop().unwrap();
        let check = |h: &Handle| -> Result<()> {
            let i = info(h)?;
            if i.attributes & 0x10 != 0 {
                return Err("NOT_REGULAR_FILE");
            }
            if i.links != 1 {
                return Err("HARD_LINK_DENIED");
            }
            if ((i.size_high as u64) << 32 | i.size_low as u64) > limit as u64 {
                return Err("FILE_TOO_LARGE");
            }
            Ok(())
        };
        check(&h)?;
        let before = info(&h)?;
        // Borrowing the owned handle through File: transfer ownership, then retain it
        // through File's RAII for the read and final metadata check.
        let raw = h.0;
        std::mem::forget(h);
        let mut file = unsafe { File::from_raw_handle(raw) };
        let mut data = Vec::new();
        (&mut file)
            .take(limit as u64 + 1)
            .read_to_end(&mut data)
            .map_err(|_| "READ_FAILED")?;
        let borrowed = std::mem::ManuallyDrop::new(Handle(raw));
        check(&borrowed)?;
        if data.len() > limit {
            return Err("FILE_TOO_LARGE");
        }
        let after = info(&borrowed)?;
        if before.size_high != after.size_high
            || before.size_low != after.size_low
            || before.write.high != after.write.high
            || before.write.low != after.write.low
            || data.len() as u64 != ((after.size_high as u64) << 32 | after.size_low as u64)
        {
            return Err("STALE_FILE");
        }
        Ok(data)
    }
    pub fn list(&self, parts: &[String], limit: usize) -> Result<Listing> {
        let ancestors = self.descend(parts, true)?;
        let h = ancestors.last().unwrap();
        let mut entries = Vec::new();
        let mut restart = 1;
        loop {
            // u64 alignment satisfies the native directory information ABI.
            let mut buffer = [0u64; 8192];
            let mut ios = IoStatus {
                status: 0,
                information: 0,
            };
            let status = unsafe {
                NtQueryDirectoryFile(
                    h.0,
                    null_mut(),
                    null(),
                    null(),
                    &mut ios,
                    buffer.as_mut_ptr().cast(),
                    65536,
                    1,
                    0,
                    null(),
                    restart,
                )
            };
            restart = 0;
            if status as u32 == 0x80000006 {
                return Ok(Listing {
                    entries,
                    truncated: false,
                });
            }
            if status < 0 || ios.information > 65536 {
                return Err("LIST_FAILED");
            }
            let bytes = unsafe {
                std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), ios.information)
            };
            let mut offset = 0;
            loop {
                if offset + 64 > bytes.len() {
                    return Err("LIST_FAILED");
                }
                let u32_at = |at| {
                    u32::from_le_bytes(bytes[offset + at..offset + at + 4].try_into().unwrap())
                };
                let next = u32_at(0) as usize;
                let attrs = u32_at(56);
                let len = u32_at(60) as usize;
                if len % 2 != 0 || offset + 64 + len > bytes.len() {
                    return Err("LIST_FAILED");
                }
                let wide: Vec<u16> = bytes[offset + 64..offset + 64 + len]
                    .chunks_exact(2)
                    .map(|p| u16::from_le_bytes([p[0], p[1]]))
                    .collect();
                let name = String::from_utf16(&wide).map_err(|_| "UNSUPPORTED_NAME")?;
                if name != "." && name != ".." {
                    if entries.len() == limit {
                        return Ok(Listing {
                            entries,
                            truncated: true,
                        });
                    }
                    crate::component(&name).map_err(|_| "UNSUPPORTED_NAME")?;
                    let kind = if attrs & 0x400 != 0 {
                        "other"
                    } else if attrs & 0x10 != 0 {
                        "directory"
                    } else {
                        "file"
                    };
                    let size =
                        i64::from_le_bytes(bytes[offset + 40..offset + 48].try_into().unwrap())
                            .max(0) as u64;
                    entries.push(Entry { name, kind, size });
                }
                if next == 0 {
                    break;
                }
                if next < 64 || offset + next >= bytes.len() {
                    return Err("LIST_FAILED");
                }
                offset += next;
            }
        }
    }
}
