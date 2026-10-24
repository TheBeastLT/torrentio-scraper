use crate::domain::config::Config;

pub const KEY: &str = "debridoptions";
pub const NO_DOWNLOAD_LINKS: &str = "nodownloadlinks";
pub const NO_CATALOG: &str = "nocatalog";

pub const OPTIONS: &[(&str, &str)] =
    &[(NO_DOWNLOAD_LINKS, "Don't show download to debrid links"), (NO_CATALOG, "Don't show debrid catalog")];

pub fn exclude_download_links(config: &Config) -> bool {
    config.preferences().debrid.exclude_download_links
}

pub fn show_debrid_catalog(config: &Config) -> bool {
    !config.preferences().debrid.hide_catalog
}
