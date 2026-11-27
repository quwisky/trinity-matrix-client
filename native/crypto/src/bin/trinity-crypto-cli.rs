//! JSON lines over stdin/stdout for host tests: a line holding an array is a batch.

use std::io::{BufRead, Write};

fn main() -> std::io::Result<()> {
    let mut stdout = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        let response = if line.trim_start().starts_with('[') {
            trinity_crypto::call_batch(&line)
        } else {
            trinity_crypto::call(&line)
        };
        writeln!(stdout, "{response}")?;
        stdout.flush()?;
    }
    Ok(())
}
