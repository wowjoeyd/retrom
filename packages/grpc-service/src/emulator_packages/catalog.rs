use retrom_codegen::retrom::EmulatorCatalogEntry;
use retrom_service_common::{config::ServerConfigManager, emulator_catalog};

pub async fn load_emulator_catalog(
    config_manager: &ServerConfigManager,
) -> Vec<EmulatorCatalogEntry> {
    let custom_catalog_dir = config_manager.get_config().await.custom_catalog_dir;
    emulator_catalog::load_catalog(custom_catalog_dir.as_deref())
}