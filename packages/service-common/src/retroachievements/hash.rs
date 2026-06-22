//! Safe wrapper over the vendored rcheevos `rc_hash` content hasher (via the
//! `retrom_rc_hash_file` C shim, compiled in build.rs).
//!
//! rc_hash's iterator yields one candidate hash per plausible console for a
//! given file (a `.cue`, say, could be PlayStation, Saturn, Sega CD, …). The
//! caller resolves each candidate against the RA server until one matches a
//! game — exactly how RetroAchievements clients identify content.

use std::ffi::CString;
use std::os::raw::{c_char, c_int};
use std::path::Path;

extern "C" {
    fn retrom_rc_hash_file(path: *const c_char, out: *mut c_char, max: c_int) -> c_int;
}

/// Max candidate hashes we ask rc_hash to enumerate for one file. Disc formats
/// produce the most; well above what any single extension yields.
const MAX_CANDIDATES: usize = 16;

/// Slot size in the C buffer: 32 hex chars + NUL.
const HASH_SLOT: usize = 33;

/// Compute the candidate RetroAchievements content hashes for a ROM file.
///
/// Returns an empty vec if the path is unusable or rc_hash can't hash the file
/// (unknown/unsupported format). Hashes are lowercase 32-char hex.
pub fn rc_hash_candidates(path: &Path) -> Vec<String> {
    let Ok(c_path) = CString::new(path.to_string_lossy().into_owned()) else {
        return vec![];
    };

    let mut buf = vec![0u8; MAX_CANDIDATES * HASH_SLOT];
    let count = unsafe {
        retrom_rc_hash_file(
            c_path.as_ptr(),
            buf.as_mut_ptr() as *mut c_char,
            MAX_CANDIDATES as c_int,
        )
    };

    if count <= 0 {
        return vec![];
    }

    let mut hashes = Vec::with_capacity(count as usize);
    for i in 0..(count as usize) {
        let slot = &buf[i * HASH_SLOT..i * HASH_SLOT + HASH_SLOT];
        let end = slot.iter().position(|&b| b == 0).unwrap_or(HASH_SLOT - 1);
        if let Ok(s) = std::str::from_utf8(&slot[..end]) {
            let s = s.trim();
            if !s.is_empty() {
                hashes.push(s.to_string());
            }
        }
    }

    hashes.dedup();
    hashes
}
