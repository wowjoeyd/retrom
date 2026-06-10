use super::update_handlers::{update_emulator_packages, UpdateContext};
use crate::jobs::job_manager::JobManager;
use retrom_db::Pool;
use retrom_service_common::config::ServerConfigManager;
use std::{sync::Arc, time::Duration};
use tonic::Code;

pub fn rescan_interval_hours(
    config: &retrom_codegen::retrom::ServerConfig,
) -> u32 {
    config
        .emulator_packages
        .as_ref()
        .and_then(|packages| packages.rescan_interval_hours)
        .unwrap_or(24)
}

pub async fn run(
    db_pool: Arc<Pool>,
    job_manager: Arc<JobManager>,
    config_manager: Arc<ServerConfigManager>,
) {
    tracing::info!("Emulator package rescan scheduler started");

    loop {
        let config = config_manager.get_config().await;
        let interval_hours = rescan_interval_hours(&config);

        if interval_hours == 0 {
            tracing::debug!(
                "Emulator package rescan scheduler idle (rescan_interval_hours=0)"
            );
            tokio::time::sleep(Duration::from_secs(300)).await;
            continue;
        }

        if config.emulator_package_directories.is_empty() {
            tracing::debug!(
                "Emulator package rescan skipped: no emulator_package_directories configured"
            );
        } else {
            let context = UpdateContext {
                db_pool: db_pool.clone(),
                job_manager: job_manager.clone(),
                config_manager: config_manager.clone(),
            };

            match update_emulator_packages(&context).await {
                Ok(response) => {
                    tracing::info!(
                        job_ids = ?response.job_ids,
                        "Scheduled emulator package rescan started"
                    );
                }
                Err(status) if status.code() == Code::AlreadyExists => {
                    tracing::debug!("Scheduled emulator package rescan skipped: scan already running");
                }
                Err(status) if status.code() == Code::FailedPrecondition => {
                    tracing::debug!(
                        "Scheduled emulator package rescan skipped: {}",
                        status.message()
                    );
                }
                Err(status) => {
                    tracing::warn!(
                        code = ?status.code(),
                        message = status.message(),
                        "Scheduled emulator package rescan failed"
                    );
                }
            }
        }

        let sleep_secs = u64::from(interval_hours).saturating_mul(3600);
        tokio::time::sleep(Duration::from_secs(sleep_secs.max(60))).await;
    }
}

#[cfg(test)]
mod tests {
    use super::rescan_interval_hours;
    use retrom_codegen::retrom::{EmulatorPackagesConfig, ServerConfig};

    #[test]
    fn defaults_to_24_hours_when_unset() {
        let config = ServerConfig {
            emulator_packages: None,
            ..Default::default()
        };

        assert_eq!(rescan_interval_hours(&config), 24);
    }

    #[test]
    fn respects_configured_interval() {
        let config = ServerConfig {
            emulator_packages: Some(EmulatorPackagesConfig {
                rescan_interval_hours: Some(6),
            }),
            ..Default::default()
        };

        assert_eq!(rescan_interval_hours(&config), 6);
    }

    #[test]
    fn zero_disables_scan_cadence() {
        let config = ServerConfig {
            emulator_packages: Some(EmulatorPackagesConfig {
                rescan_interval_hours: Some(0),
            }),
            ..Default::default()
        };

        assert_eq!(rescan_interval_hours(&config), 0);
    }
}