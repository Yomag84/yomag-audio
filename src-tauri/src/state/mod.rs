use parking_lot::RwLock;
use std::sync::Arc;

use crate::audio::Router;

pub struct AppState {
    pub router: Arc<RwLock<Router>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            router: Arc::new(RwLock::new(Router::new())),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
