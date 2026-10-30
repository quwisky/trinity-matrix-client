pub mod accounts;
pub mod carrier;
pub mod config;
pub mod dispatch;
pub mod failure;
pub mod wire;

#[cfg(test)]
mod tests {
    #[test]
    fn links_matrix_sdk() {
        let _ = matrix_sdk::Client::builder();
    }
}
