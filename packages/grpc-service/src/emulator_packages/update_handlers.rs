use crate::jobs::job_manager::JobError;
use retrom_codegen::retrom::{EmulatorPackageDirectory, UpdateEmulatorPackagesResponse};
use retrom_service_common::config::ServerConfigManager;
use std::sync::Arc;
use tonic::Status;
use tracing::warn;

use super::{
    layout_parser::{discover_package_roots, LayoutError},
    resolver::scan_package_roots,
};
use crate::jobs::job_manager::JobManager;
use retrom_db::Pool;

pub struct UpdateContext {
    pub db_pool: Arc<Pool>,
    pub job_manager: Arc<JobManager>,
    pub config_manager: Arc<ServerConfigManager>,
}

pub async fn update_emulator_packages(
    state: &UpdateContext,
) -> Result<UpdateEmulatorPackagesResponse, Status> {
    let directories = state
        .config_manager
        .get_config()
        .await
        .emulator_package_directories;

    if directories.is_empty() {
        return Err(Status::failed_precondition(
            "No emulator_package_directories configured",
        ));
    }

    let db_pool = state.db_pool.clone();
    let tasks: Vec<_> = directories
        .into_iter()
        .map(|directory| {
            let db_pool = db_pool.clone();
            async move { scan_directory(db_pool, directory).await }
        })
        .collect();

    let job_id = match state
        .job_manager
        .spawn("Update Emulator Packages", tasks, None)
        .await
    {
        Ok(job_id) => job_id,
        Err(JobError::JobAlreadyRunning(name)) => return Err(Status::already_exists(name)),
        Err(why) => return Err(Status::internal(format!("Failed to spawn job: {why}"))),
    };

    Ok(UpdateEmulatorPackagesResponse {
        job_ids: vec![job_id.to_string()],
    })
}

async fn scan_directory(
    db_pool: Arc<Pool>,
    directory: EmulatorPackageDirectory,
) -> Result<(), String> {
    let roots = match discover_package_roots(&directory) {
        Ok(roots) => roots,
        Err(LayoutError::MissingRoot(path)) => {
            warn!("Emulator package root missing: {}", path);
            return Ok(());
        }
        Err(why) => return Err(why.to_string()),
    };

    scan_package_roots(db_pool, roots)
        .await
        .map(|_| ())
        .map_err(|why| why.to_string())
}
