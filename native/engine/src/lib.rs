#[cfg(test)]
mod tests {
    #[test]
    fn links_matrix_sdk() {
        let _ = matrix_sdk::Client::builder();
    }
}
