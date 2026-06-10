use crate::jobs::job_manager::JobManager;
use diesel::prelude::*;
use diesel_async::RunQueryDsl;
use retrom_codegen::retrom::{
    emulator_package_service_server::EmulatorPackageService, CheckEmulatorPackageDirectoryWritableRequest,
    CheckEmulatorPackageDirectoryWritableResponse, GetEmulatorCatalogRequest,
    GetEmulatorCatalogResponse, GetEmulatorPackageFilesRequest, GetEmulatorPackageFilesResponse,
    GetEmulatorPackagesRequest, GetEmulatorPackagesResponse, InstallCatalogPackageRequest,
    InstallCatalogPackageResponse, LinkEmulatorToPackageRequest, LinkEmulatorToPackageResponse,
    LocalEmulatorConfig, NewLocalEmulatorConfig, UpdateEmulatorPackagesRequest,
    UpdateEmulatorPackagesResponse, UpdatedLocalEmulatorConfig,
};
use retrom_db::{schema, Pool};
use retrom_service_common::config::ServerConfigManager;
use std::{path::PathBuf, sync::Arc};
use tonic::{Request, Response, Status};

use super::{
    resolver::latest_package_ids_by_slug,
    update_handlers::{update_emulator_packages, UpdateContext},
};

pub struct EmulatorPackageServiceHandlers {
    db_pool: Arc<Pool>,
    job_manager: Arc<JobManager>,
    config_manager: Arc<ServerConfigManager>,
}

impl EmulatorPackageServiceHandlers {
    pub fn new(
        db_pool: Arc<Pool>,
        job_manager: Arc<JobManager>,
        config_manager: Arc<ServerConfigManager>,
    ) -> Self {
        Self {
            db_pool,
            job_manager,
            config_manager,
        }
    }
}

#[tonic::async_trait]
impl EmulatorPackageService for EmulatorPackageServiceHandlers {
    async fn get_emulator_packages(
        &self,
        request: Request<GetEmulatorPackagesRequest>,
    ) -> Result<Response<GetEmulatorPackagesResponse>, Status> {
        let request = request.into_inner();

        let mut conn = self
            .db_pool
            .get()
            .await
            .map_err(|why| Status::internal(why.to_string()))?;

        let mut query = schema::emulator_packages::table
            .into_boxed()
            .filter(schema::emulator_packages::is_deleted.eq(false));

        if !request.ids.is_empty() {
            query = query.filter(schema::emulator_packages::id.eq_any(&request.ids));
        }

        if let Some(slug) = request.package_slug.as_ref() {
            query = query.filter(schema::emulator_packages::package_slug.eq(slug));
        }

        if let Some(catalog_id) = request.catalog_id.as_ref() {
            query = query.filter(schema::emulator_packages::catalog_id.eq(catalog_id));
        }

        let packages = query
            .load::<retrom_codegen::retrom::EmulatorPackage>(&mut conn)
            .await
            .map_err(|why| Status::internal(why.to_string()))?;

        let latest_package_id_by_slug = latest_package_ids_by_slug(&packages);

        Ok(Response::new(GetEmulatorPackagesResponse {
            packages,
            latest_package_id_by_slug,
        }))
    }

    async fn get_emulator_package_files(
        &self,
        request: Request<GetEmulatorPackageFilesRequest>,
    ) -> Result<Response<GetEmulatorPackageFilesResponse>, Status> {
        let package_id = request.into_inner().package_id;

        let mut conn = self
            .db_pool
            .get()
            .await
            .map_err(|why| Status::internal(why.to_string()))?;

        let files = schema::emulator_package_files::table
            .filter(schema::emulator_package_files::package_id.eq(package_id))
            .filter(schema::emulator_package_files::is_deleted.eq(false))
            .load::<retrom_codegen::retrom::EmulatorPackageFile>(&mut conn)
            .await
            .map_err(|why| Status::internal(why.to_string()))?;

        Ok(Response::new(GetEmulatorPackageFilesResponse { files }))
    }

    async fn update_emulator_packages(
        &self,
        request: Request<UpdateEmulatorPackagesRequest>,
    ) -> Result<Response<UpdateEmulatorPackagesResponse>, Status> {
        let _ = request;
        let response = update_emulator_packages(&UpdateContext {
            db_pool: self.db_pool.clone(),
            job_manager: self.job_manager.clone(),
            config_manager: self.config_manager.clone(),
        })
        .await?;

        Ok(Response::new(response))
    }

    async fn get_emulator_catalog(
        &self,
        _request: Request<GetEmulatorCatalogRequest>,
    ) -> Result<Response<GetEmulatorCatalogResponse>, Status> {
        Ok(Response::new(GetEmulatorCatalogResponse {
            entries: vec![],
        }))
    }

    async fn check_emulator_package_directory_writable(
        &self,
        request: Request<CheckEmulatorPackageDirectoryWritableRequest>,
    ) -> Result<Response<CheckEmulatorPackageDirectoryWritableResponse>, Status> {
        let index = request.into_inner().directory_index as usize;
        let directories = self
            .config_manager
            .get_config()
            .await
            .emulator_package_directories;

        let Some(directory) = directories.get(index) else {
            return Ok(Response::new(CheckEmulatorPackageDirectoryWritableResponse {
                writable: false,
                error_message: Some(format!("directory_index {index} is out of range")),
            }));
        };

        let test_dir = PathBuf::from(&directory.path);
        let test_file = test_dir.join(".retrom-write-test");

        match std::fs::create_dir_all(&test_dir)
            .and_then(|_| std::fs::write(&test_file, b"1"))
            .and_then(|_| std::fs::remove_file(&test_file))
        {
            Ok(()) => Ok(Response::new(CheckEmulatorPackageDirectoryWritableResponse {
                writable: true,
                error_message: None,
            })),
            Err(why) => Ok(Response::new(CheckEmulatorPackageDirectoryWritableResponse {
                writable: false,
                error_message: Some(why.to_string()),
            })),
        }
    }

    async fn install_catalog_package(
        &self,
        _request: Request<InstallCatalogPackageRequest>,
    ) -> Result<Response<InstallCatalogPackageResponse>, Status> {
        Err(Status::unimplemented(
            "Catalog install is implemented in a follow-up PR (service-common install job)",
        ))
    }

    async fn link_emulator_to_package(
        &self,
        request: Request<LinkEmulatorToPackageRequest>,
    ) -> Result<Response<LinkEmulatorToPackageResponse>, Status> {
        let request = request.into_inner();

        let mut conn = self
            .db_pool
            .get()
            .await
            .map_err(|why| Status::internal(why.to_string()))?;

        let package = schema::emulator_packages::table
            .filter(schema::emulator_packages::id.eq(request.package_id))
            .filter(schema::emulator_packages::is_deleted.eq(false))
            .first::<retrom_codegen::retrom::EmulatorPackage>(&mut conn)
            .await
            .optional()
            .map_err(|why| Status::internal(why.to_string()))?
            .ok_or_else(|| Status::not_found("Emulator package not found"))?;

        let managed_paths = request.managed_paths.unwrap_or(true);
        let executable_path = PathBuf::from(&package.root_path).join(&package.executable_rel);

        let existing = schema::local_emulator_configs::table
            .filter(schema::local_emulator_configs::emulator_id.eq(request.emulator_id))
            .filter(schema::local_emulator_configs::client_id.eq(request.client_id))
            .first::<LocalEmulatorConfig>(&mut conn)
            .await
            .optional()
            .map_err(|why| Status::internal(why.to_string()))?;

        let local_config = if let Some(existing) = existing {
            diesel::update(schema::local_emulator_configs::table)
                .filter(schema::local_emulator_configs::id.eq(existing.id))
                .set(UpdatedLocalEmulatorConfig {
                    id: existing.id,
                    linked_package_id: Some(request.package_id),
                    managed_paths: Some(managed_paths),
                    executable_path: Some(executable_path.to_string_lossy().to_string()),
                    ..Default::default()
                })
                .get_result::<LocalEmulatorConfig>(&mut conn)
                .await
                .map_err(|why| Status::internal(why.to_string()))?
        } else {
            diesel::insert_into(schema::local_emulator_configs::table)
                .values(NewLocalEmulatorConfig {
                    emulator_id: request.emulator_id,
                    client_id: request.client_id,
                    executable_path: executable_path.to_string_lossy().to_string(),
                    linked_package_id: Some(request.package_id),
                    managed_paths: Some(managed_paths),
                    ..Default::default()
                })
                .get_result::<LocalEmulatorConfig>(&mut conn)
                .await
                .map_err(|why| Status::internal(why.to_string()))?
        };

        Ok(Response::new(LinkEmulatorToPackageResponse {
            local_config: Some(local_config),
        }))
    }
}