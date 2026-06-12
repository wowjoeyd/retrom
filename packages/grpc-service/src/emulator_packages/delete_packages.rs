use diesel::prelude::*;
use diesel_async::RunQueryDsl;
use retrom_codegen::timestamp::Timestamp;
use retrom_db::{schema, Pool};
use std::{path::PathBuf, sync::Arc, time::SystemTime};
use tonic::Status;

pub async fn delete_emulator_packages(
    db_pool: Arc<Pool>,
    package_ids: Vec<i32>,
    delete_files: bool,
) -> Result<Vec<i32>, Status> {
    let mut conn = db_pool
        .get()
        .await
        .map_err(|why| Status::internal(why.to_string()))?;

    let mut deleted = Vec::new();
    let now: Timestamp = SystemTime::now().into();

    for package_id in package_ids {
        let package = schema::emulator_packages::table
            .filter(schema::emulator_packages::id.eq(package_id))
            .filter(schema::emulator_packages::is_deleted.eq(false))
            .first::<retrom_codegen::retrom::EmulatorPackage>(&mut conn)
            .await
            .optional()
            .map_err(|why| Status::internal(why.to_string()))?;

        let Some(package) = package else {
            continue;
        };

        diesel::update(schema::local_emulator_configs::table)
            .filter(schema::local_emulator_configs::linked_package_id.eq(package_id))
            .set((
                schema::local_emulator_configs::linked_package_id.eq(None::<i32>),
                schema::local_emulator_configs::managed_paths.eq(false),
            ))
            .execute(&mut conn)
            .await
            .map_err(|why| Status::internal(why.to_string()))?;

        diesel::update(schema::emulator_package_files::table)
            .filter(schema::emulator_package_files::package_id.eq(package_id))
            .filter(schema::emulator_package_files::is_deleted.eq(false))
            .set((
                schema::emulator_package_files::is_deleted.eq(true),
                schema::emulator_package_files::deleted_at.eq(Some(now)),
            ))
            .execute(&mut conn)
            .await
            .map_err(|why| Status::internal(why.to_string()))?;

        diesel::update(schema::emulator_packages::table)
            .filter(schema::emulator_packages::id.eq(package_id))
            .set((
                schema::emulator_packages::is_deleted.eq(true),
                schema::emulator_packages::deleted_at.eq(Some(now)),
            ))
            .execute(&mut conn)
            .await
            .map_err(|why| Status::internal(why.to_string()))?;

        if delete_files {
            let root = PathBuf::from(&package.root_path);
            if root.exists() {
                if let Err(why) = std::fs::remove_dir_all(&root) {
                    tracing::warn!(
                        "Failed to remove emulator package files at {:?}: {why}",
                        root
                    );
                }
            }
        }

        deleted.push(package_id);
    }

    Ok(deleted)
}
