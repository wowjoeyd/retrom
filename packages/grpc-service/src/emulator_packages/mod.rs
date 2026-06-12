mod catalog;
mod install_job;
mod layout_parser;
mod manifest;
mod resolver;
mod scheduler;
mod service;
mod update_handlers;

pub use scheduler::run as run_emulator_package_scheduler;
pub use service::EmulatorPackageServiceHandlers;

pub fn emulator_packages_enabled() -> bool {
    std::env::var("RETROM_EMULATOR_PACKAGES_ENABLED")
        .map(|value| value != "false")
        .unwrap_or(true)
}
