use diesel::prelude::*;
use diesel_async::RunQueryDsl;
use retrom_codegen::{
    retrom::{
        emulator::OperatingSystem, SaveStrategy, EmulatorCatalogEntry, NewEmulator,
        NewEmulatorProfile, NewLocalEmulatorConfig,
    },
    timestamp::Timestamp,
};
use retrom_db::{schema, Pool};
use retrom_service_common::{
    config::ServerConfigManager,
    emulator_catalog::{recommend_target_os, resolve_platform_ids_for_catalog_entry},
    emulator_catalog_install::{install_catalog_package, InstallCatalogParams},
};
use std::{
    path::PathBuf,
    sync::Arc,
    time::SystemTime,
};
use super::resolver::{resolve_package_at_root, upsert_resolved_package};
use crate::jobs::job_manager::JobManager;

pub struct InstallJobContext {
    pub db_pool: Arc<Pool>,
    pub job_manager: Arc<JobManager>,
    pub config_manager: Arc<ServerConfigManager>,
}

pub struct InstallJobRequest {
    pub catalog_id: String,
    pub directory_index: usize,
    pub subpath: Option<String>,
    pub client_id: i32,
    pub target_operating_system: Option<i32>,
}

pub async fn spawn_install_catalog_job(
    ctx: &InstallJobContext,
    request: InstallJobRequest,
) -> Result<uuid::Uuid, String> {
    let db_pool = ctx.db_pool.clone();
    let config_manager = ctx.config_manager.clone();

    let task = async move {
        run_install_catalog_job(db_pool, config_manager, request).await
    };

    ctx.job_manager
        .spawn("Install Catalog Package", vec![task], None)
        .await
        .map_err(|why| why.to_string())
}

async fn run_install_catalog_job(
    db_pool: Arc<Pool>,
    config_manager: Arc<ServerConfigManager>,
    request: InstallJobRequest,
) -> Result<(), String> {
    let config = config_manager.get_config().await;
    let custom_catalog_dir = config.custom_catalog_dir.clone();
    let directories = config.emulator_package_directories;

    let directory = directories
        .get(request.directory_index)
        .ok_or_else(|| format!("directory_index {} is out of range", request.directory_index))?;

    let entries = retrom_service_common::emulator_catalog::load_catalog(custom_catalog_dir.as_deref());
    let entry = entries
        .into_iter()
        .find(|e| e.catalog_id == request.catalog_id)
        .ok_or_else(|| format!("catalog entry not found: {}", request.catalog_id))?;

    let host_os = retrom_service_common::emulator_catalog::host_operating_system();
    let target_os = request
        .target_operating_system
        .and_then(|os| OperatingSystem::try_from(os).ok())
        .unwrap_or_else(|| recommend_target_os(&entry, host_os));

    if retrom_service_common::emulator_catalog::resolve_target_for_os(&entry, target_os).is_none() {
        return Err(format!(
            "catalog entry {} has no install target for {:?}",
            request.catalog_id, target_os
        ));
    }

    let install_result = install_catalog_package(InstallCatalogParams {
        entry: entry.clone(),
        target_os,
        install_root: PathBuf::from(&directory.path),
        subpath: request.subpath.clone(),
    })
    .await
    .map_err(|why| why.to_string())?;

    let package_id = scan_installed_package(db_pool.clone(), &install_result.package_root).await?;

    auto_provision_emulator(
        db_pool,
        &entry,
        package_id,
        &install_result.executable_rel,
        request.client_id,
    )
    .await
    .map_err(|why| why.to_string())?;

    Ok(())
}

async fn scan_installed_package(
    db_pool: Arc<Pool>,
    package_root: &PathBuf,
) -> Result<i32, String> {
    let resolved = resolve_package_at_root(package_root)
        .await
        .map_err(|why| why.to_string())?;
    upsert_resolved_package(db_pool, resolved)
        .await
        .map_err(|why| why.to_string())
}

async fn auto_provision_emulator(
    db_pool: Arc<Pool>,
    entry: &EmulatorCatalogEntry,
    package_id: i32,
    executable_rel: &str,
    client_id: i32,
) -> Result<(), String> {
    let mut conn = db_pool.get().await.map_err(|why| why.to_string())?;

    let package = schema::emulator_packages::table
        .filter(schema::emulator_packages::id.eq(package_id))
        .first::<retrom_codegen::retrom::EmulatorPackage>(&mut conn)
        .await
        .map_err(|why| why.to_string())?;

    let platforms = schema::platforms::table
        .load::<retrom_codegen::retrom::Platform>(&mut conn)
        .await
        .map_err(|why| why.to_string())?;

    let platform_ids = resolve_platform_ids_for_catalog_entry(
        &entry.supported_platform_folder_names,
        &platforms,
    );

    let emulator = schema::emulators::table
        .filter(schema::emulators::name.eq(&entry.display_name))
        .filter(schema::emulators::built_in.eq(false))
        .first::<retrom_codegen::retrom::Emulator>(&mut conn)
        .await
        .optional()
        .map_err(|why| why.to_string())?;

    let emulator_id = if let Some(existing) = emulator {
        existing.id
    } else {
        let operating_systems: Vec<i32> = entry.operating_systems.clone();
        let created = diesel::insert_into(schema::emulators::table)
            .values(NewEmulator {
                name: entry.display_name.clone(),
                supported_platforms: platform_ids,
                save_strategy: SaveStrategy::FileSystemDirectory as i32,
                built_in: Some(false),
                operating_systems,
                ..Default::default()
            })
            .get_result::<retrom_codegen::retrom::Emulator>(&mut conn)
            .await
            .map_err(|why| why.to_string())?;
        created.id
    };

    let profile_name = entry
        .default_profile
        .as_ref()
        .map(|p| p.name.clone())
        .unwrap_or_else(|| "Default".to_string());

    let profile = schema::emulator_profiles::table
        .filter(schema::emulator_profiles::emulator_id.eq(emulator_id))
        .filter(schema::emulator_profiles::name.eq(&profile_name))
        .first::<retrom_codegen::retrom::EmulatorProfile>(&mut conn)
        .await
        .optional()
        .map_err(|why| why.to_string())?;

    if profile.is_none() {
        if let Some(default_profile) = entry.default_profile.as_ref() {
            diesel::insert_into(schema::emulator_profiles::table)
                .values(NewEmulatorProfile {
                    emulator_id,
                    name: default_profile.name.clone(),
                    supported_extensions: default_profile.supported_extensions.clone(),
                    custom_args: default_profile.custom_args.clone(),
                    built_in: Some(false),
                    ..Default::default()
                })
                .execute(&mut conn)
                .await
                .map_err(|why| why.to_string())?;
        }
    }

    let executable_path = PathBuf::from(&package.root_path)
        .join(executable_rel)
        .to_string_lossy()
        .to_string();

    let existing_config = schema::local_emulator_configs::table
        .filter(schema::local_emulator_configs::emulator_id.eq(emulator_id))
        .filter(schema::local_emulator_configs::client_id.eq(client_id))
        .first::<retrom_codegen::retrom::LocalEmulatorConfig>(&mut conn)
        .await
        .optional()
        .map_err(|why| why.to_string())?;

    if let Some(existing) = existing_config {
        diesel::update(schema::local_emulator_configs::table)
            .filter(schema::local_emulator_configs::id.eq(existing.id))
            .set((
                schema::local_emulator_configs::linked_package_id.eq(Some(package_id)),
                schema::local_emulator_configs::managed_paths.eq(true),
                schema::local_emulator_configs::executable_path.eq(&executable_path),
                schema::local_emulator_configs::updated_at
                    .eq(Some(Timestamp::from(SystemTime::now()))),
            ))
            .execute(&mut conn)
            .await
            .map_err(|why| why.to_string())?;
    } else {
        diesel::insert_into(schema::local_emulator_configs::table)
            .values(NewLocalEmulatorConfig {
                emulator_id,
                client_id,
                executable_path,
                linked_package_id: Some(package_id),
                managed_paths: Some(true),
                ..Default::default()
            })
            .execute(&mut conn)
            .await
            .map_err(|why| why.to_string())?;
    }

    Ok(())
}