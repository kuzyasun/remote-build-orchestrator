use std::fs::File;
use std::io::{self, Read, Write};
use std::mem::{offset_of, size_of};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;

use serde::Deserialize;
use windows::core::{PCWSTR, PWSTR};
use windows::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows::Wdk::Storage::FileSystem::{
    FileRenameInformation, NtCreateFile, NtSetInformationFile, FILE_CREATE,
    FILE_NON_DIRECTORY_FILE, FILE_OPEN_REPARSE_POINT, FILE_RENAME_INFORMATION,
    FILE_SYNCHRONOUS_IO_NONALERT,
};
use windows::Win32::Foundation::{
    RtlNtStatusToDosError, BOOLEAN, HANDLE, NTSTATUS, STATUS_OBJECT_NAME_COLLISION, UNICODE_STRING,
};
use windows::Win32::Security::Cryptography::{
    BCryptCreateHash, BCryptDestroyHash, BCryptFinishHash, BCryptGenRandom, BCryptHashData,
    BCRYPT_ALG_HANDLE, BCRYPT_HASH_HANDLE, BCRYPT_SHA256_ALG_HANDLE,
    BCRYPT_USE_SYSTEM_PREFERRED_RNG,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FileDispositionInfo, GetFileInformationByHandle, GetFinalPathNameByHandleW,
    SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_NORMAL, FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_GENERIC_WRITE,
    FILE_READ_ATTRIBUTES, FILE_SHARE_MODE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE,
    OPEN_EXISTING, VOLUME_NAME_DOS,
};
use windows::Win32::System::IO::IO_STATUS_BLOCK;

const MAX_FILENAME_UNITS: usize = 255;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    parent_path: String,
    parent_device: String,
    parent_inode: String,
    source_path: String,
    destination_name: String,
    sha256: String,
    overwrite: bool,
}

pub fn run() {
    let request = match serde_json::from_reader(io::stdin().lock()) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("Invalid artifact publication request ({error})");
            std::process::exit(1);
        }
    };
    if let Err(error) = publish(request) {
        eprintln!("{error}");
        std::process::exit(1);
    }
    println!("rbo-artifact-publication-v1");
}

fn publish(request: Request) -> io::Result<()> {
    let destination = destination_name(&request.destination_name)?;
    let parent = open_verified_parent(&request)?;
    let mut source = File::open(&request.source_path)?;
    let hash = Sha256::new()?;
    let mut stage = create_stage(&parent)?;
    let result = copy_verified(&mut source, &mut stage, &hash, &request.sha256)
        .and_then(|()| rename_stage(&stage, &destination, request.overwrite));
    if let Err(error) = result {
        if let Err(cleanup_error) = delete_stage(&stage) {
            return Err(io::Error::other(format!(
                "{error}. Could not remove artifact staging file ({cleanup_error})"
            )));
        }
        return Err(error);
    }
    Ok(())
}

fn destination_name(name: &str) -> io::Result<Vec<u16>> {
    let wide: Vec<_> = name.encode_utf16().collect();
    if wide.is_empty()
        || wide.len() > MAX_FILENAME_UNITS
        || name.ends_with(['.', ' '])
        || name.chars().any(|c| c < ' ' || r#"\/:*?"<>|"#.contains(c))
    {
        return Err(io::Error::other("Destination must name a file"));
    }
    let stem = name.split('.').next().unwrap_or_default().trim_end();
    let upper_stem = stem.to_ascii_uppercase();
    if matches!(upper_stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || upper_stem
            .strip_prefix("COM")
            .or_else(|| upper_stem.strip_prefix("LPT"))
            .is_some_and(|unit| {
                matches!(
                    unit,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
    {
        return Err(io::Error::other("Destination must name a file"));
    }
    Ok(wide)
}

fn open_verified_parent(request: &Request) -> io::Result<OwnedHandle> {
    if !request.parent_path.starts_with(r"\\?\")
        || !Path::new(&request.parent_path).is_absolute()
        || request.parent_path.contains('\0')
    {
        return Err(io::Error::other(
            "Invalid canonical destination parent path",
        ));
    }
    let expected_device: u32 = request.parent_device.parse().map_err(io::Error::other)?;
    let expected_inode: u64 = request.parent_inode.parse().map_err(io::Error::other)?;
    let mut expected: Vec<_> = request.parent_path.encode_utf16().collect();
    expected.push(0);
    let handle = unsafe {
        CreateFileW(
            PCWSTR(expected.as_ptr()),
            (FILE_READ_ATTRIBUTES | FILE_TRAVERSE).0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )
    }
    .map_err(io::Error::other)?;
    let parent = unsafe { OwnedHandle::from_raw_handle(handle.0) };
    let mut identity = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(handle, &mut identity) }.map_err(io::Error::other)?;
    let inode = (u64::from(identity.nFileIndexHigh) << 32) | u64::from(identity.nFileIndexLow);
    let mut actual = vec![0; 32768];
    let length =
        unsafe { GetFinalPathNameByHandleW(handle, &mut actual, VOLUME_NAME_DOS) } as usize;
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    let separator = [u16::from(b'\\')];
    let actual_path = &actual[..length.min(actual.len())];
    let expected_path = &expected[..expected.len() - 1];
    if length >= actual.len()
        || identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0
        || identity.dwVolumeSerialNumber != expected_device
        || inode != expected_inode
        // The same Windows API supplies Node's canonical path. Preserve component case.
        || actual_path.strip_suffix(&separator).unwrap_or(actual_path)
            != expected_path.strip_suffix(&separator).unwrap_or(expected_path)
    {
        return Err(io::Error::other(
            "Destination parent directory changed before materialization",
        ));
    }
    Ok(parent)
}

fn create_stage(parent: &OwnedHandle) -> io::Result<File> {
    let mut random = [0; 16];
    check_status(unsafe {
        BCryptGenRandom(
            BCRYPT_ALG_HANDLE::default(),
            &mut random,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    })?;
    let mut name: Vec<_> = format!(".rbo-artifact-{:032x}", u128::from_ne_bytes(random))
        .encode_utf16()
        .collect();
    let name_length = (name.len() * size_of::<u16>()) as u16;
    let name = UNICODE_STRING {
        Length: name_length,
        MaximumLength: name_length,
        Buffer: PWSTR(name.as_mut_ptr()),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: HANDLE(parent.as_raw_handle()),
        ObjectName: &name,
        ..Default::default()
    };
    let mut handle = HANDLE::default();
    check_status(unsafe {
        NtCreateFile(
            &mut handle,
            FILE_GENERIC_WRITE | DELETE,
            &attributes,
            &mut IO_STATUS_BLOCK::default(),
            None,
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_MODE(0),
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            None,
            0,
        )
    })?;
    Ok(unsafe { File::from_raw_handle(handle.0) })
}

fn copy_verified(
    source: &mut File,
    stage: &mut File,
    hash: &Sha256,
    expected_sha256: &str,
) -> io::Result<()> {
    let mut buffer = [0; 65536];
    loop {
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let chunk = &buffer[..count];
        stage.write_all(chunk)?;
        check_status(unsafe { BCryptHashData(hash.0, chunk, 0) })?;
    }
    let mut digest = [0; 32];
    check_status(unsafe { BCryptFinishHash(hash.0, &mut digest, 0) })?;
    let actual = digest.map(|byte| format!("{byte:02x}")).concat();
    if actual != expected_sha256 {
        return Err(io::Error::other("Stored artifact hash mismatch"));
    }
    Ok(())
}

#[repr(C)]
struct RenameInformation {
    replace_if_exists: u32,
    root_directory: HANDLE,
    file_name_length: u32,
    file_name: [u16; MAX_FILENAME_UNITS + 1],
}

const _: () = assert!(
    offset_of!(RenameInformation, file_name) == offset_of!(FILE_RENAME_INFORMATION, FileName)
);

fn rename_stage(stage: &File, destination: &[u16], overwrite: bool) -> io::Result<()> {
    // A simple name with a null RootDirectory uses the staging file's existing parent.
    let mut info = RenameInformation {
        replace_if_exists: u32::from(overwrite),
        root_directory: HANDLE::default(),
        file_name_length: (destination.len() * size_of::<u16>()) as u32,
        file_name: [0; MAX_FILENAME_UNITS + 1],
    };
    info.file_name[..destination.len()].copy_from_slice(destination);
    let status = unsafe {
        NtSetInformationFile(
            HANDLE(stage.as_raw_handle()),
            &mut IO_STATUS_BLOCK::default(),
            (&info as *const RenameInformation).cast(),
            size_of::<RenameInformation>() as u32,
            FileRenameInformation,
        )
    };
    if !overwrite && status == STATUS_OBJECT_NAME_COLLISION {
        return Err(io::Error::other("Destination exists and overwrite=false"));
    }
    check_status(status)
}

fn delete_stage(stage: &File) -> windows::core::Result<()> {
    let info = FILE_DISPOSITION_INFO {
        DeleteFile: BOOLEAN(1),
    };
    unsafe {
        SetFileInformationByHandle(
            HANDLE(stage.as_raw_handle()),
            FileDispositionInfo,
            (&info as *const FILE_DISPOSITION_INFO).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    }
}

struct Sha256(BCRYPT_HASH_HANDLE);

impl Sha256 {
    fn new() -> io::Result<Self> {
        let mut handle = BCRYPT_HASH_HANDLE::default();
        check_status(unsafe {
            BCryptCreateHash(BCRYPT_SHA256_ALG_HANDLE, &mut handle, None, None, 0)
        })?;
        Ok(Self(handle))
    }
}

impl Drop for Sha256 {
    fn drop(&mut self) {
        let _ = unsafe { BCryptDestroyHash(self.0) };
    }
}

fn check_status(status: NTSTATUS) -> io::Result<()> {
    if status.is_ok() {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ))
    }
}
