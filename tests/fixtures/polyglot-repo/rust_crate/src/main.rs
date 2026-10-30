mod config;
mod service;

use std::collections::HashMap;
use crate::config::AppConfig;
use crate::service::execute;

fn main() {
    execute();
}

