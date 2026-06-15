use retrom_codegen::retrom::{emulator::OperatingSystem, EmulatorCatalogEntry};
use retrom_service_common::{config::ServerConfigManager, emulator_catalog};

pub async fn load_emulator_catalog(
    config_manager: &ServerConfigManager,
) -> (Vec<EmulatorCatalogEntry>, OperatingSystem) {
    let custom_catalog_dir = config_manager.get_config().await.custom_catalog_dir;
    let host_os = emulator_catalog::host_operating_system();
    let entries = emulator_catalog::load_catalog(custom_catalog_dir.as_deref());
    (entries, host_os)
}
