use std::path::Path;

pub fn move_path(src: &Path, dest: &Path) -> std::io::Result<()> {
    match std::fs::rename(src, dest) {
        Ok(()) => Ok(()),
        Err(err) if is_cross_device_rename_error(&err) => {
            if src.is_dir() {
                copy_dir_recursive(src, dest)?;
                std::fs::remove_dir_all(src)?;
            } else {
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::copy(src, dest)?;
                std::fs::remove_file(src)?;
            }
            Ok(())
        }
        Err(err) => Err(err),
    }
}

fn is_cross_device_rename_error(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::CrossesDevices || err.raw_os_error() == Some(17)
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let dest_entry = dest.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_entry)?;
        } else {
            if let Some(parent) = dest_entry.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(entry.path(), &dest_entry)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn move_path_works_within_same_directory() {
        let base = tempfile::tempdir().expect("tempdir");
        let src = base.path().join("src.txt");
        let dest = base.path().join("dest.txt");
        std::fs::write(&src, b"payload").expect("write src");

        move_path(&src, &dest).expect("move path");

        assert!(!src.exists());
        assert_eq!(std::fs::read(dest).expect("read dest"), b"payload");
    }

    #[test]
    fn move_path_copies_directories_when_rename_fails() {
        let base = tempfile::tempdir().expect("tempdir");
        let src_dir = base.path().join("nested");
        let nested_file = src_dir.join("child").join("file.txt");
        std::fs::create_dir_all(nested_file.parent().expect("parent")).expect("mkdir");
        std::fs::write(&nested_file, b"nested").expect("write nested");

        let dest_dir = base.path().join("moved");
        copy_dir_recursive(&src_dir, &dest_dir).expect("copy dir");
        std::fs::remove_dir_all(&src_dir).expect("remove src");

        let copied = dest_dir.join("child").join("file.txt");
        assert!(copied.is_file());
        assert_eq!(std::fs::read(copied).expect("read copied"), b"nested");
    }
}
