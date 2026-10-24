use crate::domain::SourceError;

#[derive(Debug, thiserror::Error)]
pub enum CatalogError {
    #[error(transparent)]
    Source(#[from] SourceError),
    #[error("cursor not found")]
    CursorNotFound,
    #[error("This job has been dropped by Bottleneck")]
    Dropped,
}

impl CatalogError {
    pub fn outcome(&self) -> &'static str {
        match self {
            Self::Source(_) => "error",
            Self::CursorNotFound | Self::Dropped => "degraded",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum HandlerError {
    #[error("No catalog found for with id: {0}")]
    UnknownCatalog(String),
}
