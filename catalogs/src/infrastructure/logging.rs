use std::io;

use tracing::Level;
use tracing_subscriber::{
    EnvFilter,
    fmt::{MakeWriter, writer::MakeWriterExt},
};

const DEFAULT_FILTER: &str = "info";

pub fn init() {
    let writer = io::stderr.with_max_level(Level::WARN).or_else(io::stdout);
    subscribe(writer);
}

fn subscribe<W>(writer: W)
where
    W: for<'writer> MakeWriter<'writer> + Send + Sync + 'static,
{
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER));
    let _ = tracing_subscriber::fmt()
        .json()
        .flatten_event(true)
        .with_current_span(false)
        .with_span_list(false)
        .without_time()
        .with_target(false)
        .with_env_filter(filter)
        .with_writer(writer)
        .try_init();
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<u8>>>);

    impl io::Write for Capture {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl<'writer> MakeWriter<'writer> for Capture {
        type Writer = Capture;

        fn make_writer(&'writer self) -> Self::Writer {
            self.clone()
        }
    }

    #[test]
    fn emits_flat_json_lines_without_timestamps() {
        let capture = Capture::default();
        let subscriber = tracing_subscriber::fmt()
            .json()
            .flatten_event(true)
            .with_current_span(false)
            .with_span_list(false)
            .without_time()
            .with_target(false)
            .with_writer(capture.clone())
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            tracing::warn!("Failed retrieving catalog top-movies: cursor not found");
        });
        let line = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
        let json: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(json["level"], "WARN");
        assert_eq!(json["message"], "Failed retrieving catalog top-movies: cursor not found");
        assert!(json.get("timestamp").is_none());
    }
}
