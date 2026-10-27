mod error;
mod http;
mod util;

pub mod alldebrid;
pub mod debridlink;
pub mod deepbrid;
pub mod easydebrid;
pub mod highway;
pub mod offcloud;
pub mod premiumize;
pub mod putio;
pub mod realdebrid;
pub mod torbox;

pub use error::{Error, Result};
pub use http::{Http, Reply, USER_AGENT};
