// Compile the vendored rcheevos rc_hash content-hashing sources (MIT, under
// third_party/rcheevos) plus our thin shim into a static lib linked into this
// crate. We FFI to rc_hash rather than reimplementing per-console hashing —
// disc/N64/arcade/DS hashing is intricate and must match RetroAchievements byte
// for byte. Vendored (not a submodule) because CI checkout does not init
// submodules and `vendor/` is gitignored.

use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let rc = manifest.join("third_party/rcheevos");
    let rhash = rc.join("src/rhash");

    let sources = [
        rhash.join("hash.c"),
        rhash.join("cdreader.c"),
        rhash.join("md5.c"),
        rhash.join("aes.c"),
        manifest.join("csrc/rahash_shim.c"),
    ];

    let mut build = cc::Build::new();
    build
        .include(rc.join("include"))
        .include(rc.join("src"))
        .warnings(false)
        // rc_hash uses fopen et al.; silence MSVC's "use the _s variants" errors.
        .define("_CRT_SECURE_NO_WARNINGS", None);

    for src in &sources {
        build.file(src);
        println!("cargo:rerun-if-changed={}", src.display());
    }

    println!(
        "cargo:rerun-if-changed={}",
        manifest
            .join("third_party/rcheevos/include/rc_hash.h")
            .display()
    );

    build.compile("retrom_rahash");
}
