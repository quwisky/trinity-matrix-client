//! `MediaEngine`: media bytes behind random tokens.

pub mod tokens;

use tokens::MediaTokens;

/// The media an engine holds in memory for its hosts.
#[derive(Default)]
pub(crate) struct MediaState {
    pub(crate) tokens: MediaTokens,
}
