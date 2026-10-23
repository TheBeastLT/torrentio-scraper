use std::{fmt::Display, sync::Arc};

#[derive(Clone, Debug, thiserror::Error)]
pub enum HandlerError {
    #[error("not found")]
    NotFound,
    #[error("{0:#}")]
    Failed(Arc<anyhow::Error>),
}

impl HandlerError {
    pub fn failed(error: impl Into<anyhow::Error>) -> Self {
        Self::Failed(Arc::new(error.into()))
    }

    pub fn message(message: impl Display) -> Self {
        Self::Failed(Arc::new(anyhow::anyhow!("{message}")))
    }
}
