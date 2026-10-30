pub mod accounts;
pub mod barrier;
pub mod carrier;
pub mod config;
pub mod dispatch;
pub mod engines;
pub mod failure;
#[cfg(feature = "native")]
mod store;
pub mod wire;

#[cfg(test)]
mod tests {
    #[test]
    fn links_matrix_sdk() {
        let _ = matrix_sdk::Client::builder();
    }
}
