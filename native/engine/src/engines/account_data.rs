//! Global account data, read and written as JSON. A command wraps each call in
//! `Engine::ruled`; a stream calls it directly.

use std::{future::IntoFuture, time::Duration};

use matrix_sdk::{
    Client, Error,
    config::RequestConfig,
    ruma::{
        api::{
            client::config::{get_global_account_data, set_global_account_data},
            error::ErrorKind,
        },
        events::GlobalAccountDataEventType,
        serde::Raw,
    },
    timeout::timeout,
};
use serde_json::Value;

use super::member::sent_once;

/// How long a write may take, its retries included: half of the teardown's `HOLDER_LIMIT`
/// (120 s), which leaves a command body the other half for a read and the rule's waits.
const ACCOUNT_DATA_LIMIT: Duration = Duration::from_secs(60);

/// `GET /user/{me}/account_data/{event_type}`, sent once; `M_NOT_FOUND` is `None` (as
/// `Account::fetch_account_data`).
pub async fn get(client: &Client, event_type: &str) -> Result<Option<Value>, Error> {
    let me = client.user_id().ok_or(Error::AuthenticationRequired)?;
    let event_type = GlobalAccountDataEventType::from(event_type);
    let request = get_global_account_data::v3::Request::new(me.to_owned(), event_type);
    match client.send(request).with_request_config(sent_once()).await {
        Ok(response) => Ok(Some(response.account_data.deserialize_as()?)),
        Err(err) if err.client_api_error_kind() == Some(&ErrorKind::NotFound) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

/// `PUT` with `account_data_retried()`: at most five attempts, as js `setAccountData`, cut off
/// after `ACCOUNT_DATA_LIMIT` as an `ElapsedError`.
pub async fn put(client: &Client, event_type: &str, content: &Value) -> Result<(), Error> {
    put_within(client, event_type, content, ACCOUNT_DATA_LIMIT).await
}

async fn put_within(
    client: &Client,
    event_type: &str,
    content: &Value,
    limit: Duration,
) -> Result<(), Error> {
    let me = client.user_id().ok_or(Error::AuthenticationRequired)?;
    let event_type = GlobalAccountDataEventType::from(event_type);
    let data = Raw::new(content)?.cast_unchecked();
    let request = set_global_account_data::v3::Request::new_raw(me.to_owned(), event_type, data);
    let send = client
        .send(request)
        .with_request_config(account_data_retried());
    timeout(send.into_future(), limit)
        .await
        .map_err(|elapsed| Error::UnknownError(Box::new(elapsed)))??;
    Ok(())
}

/// A global account-data write, as js `setAccountData` sends it: 5 attempts in all (`retry_limit`
/// counts attempts, `http_client/native.rs:67-71`). Room account data is `sent_once` (js
/// `setRoomAccountData` sends once).
fn account_data_retried() -> RequestConfig {
    RequestConfig::new().retry_limit(5)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{
        accounts::Engine,
        config::EngineConfig,
        failure::{FailureKind, request_failed},
        testing::{Seen, default_client, password, requests, scripted},
    };

    const GET: &str = "GET /_matrix/client/v3/user/@a:b/account_data/x.y";
    const PUT: &str = "PUT /_matrix/client/v3/user/@a:b/account_data/x.y";

    /// A restored client on the SDK's default config, which retries, answered with `answers`.
    async fn client_on(answers: Vec<(&'static str, u16, Value)>) -> (Client, Seen) {
        let (base, seen) = scripted(answers);
        let engine = Engine::new(EngineConfig::default()).unwrap();
        (default_client(&engine, &password(&base)).await, seen)
    }

    fn unavailable() -> Value {
        json!({"errcode": "M_UNKNOWN", "error": "x"})
    }

    #[tokio::test]
    async fn an_absent_event_reads_as_none_and_a_present_one_as_its_content() {
        let absent = json!({"errcode": "M_NOT_FOUND", "error": "x"});
        let answers = vec![(GET, 404, absent), (GET, 200, json!({"a": 1}))];
        let (client, seen) = client_on(answers).await;
        assert_eq!(get(&client, "x.y").await.unwrap(), None);
        assert_eq!(get(&client, "x.y").await.unwrap(), Some(json!({"a": 1})));
        assert_eq!(requests(&seen).len(), 2);
    }

    #[tokio::test]
    async fn a_502_fails_a_get_after_one_request() {
        let answers = vec![(GET, 502, unavailable()), (GET, 200, json!({}))];
        let (client, seen) = client_on(answers).await;
        assert!(get(&client, "x.y").await.is_err());
        assert_eq!(requests(&seen).len(), 1);
    }

    #[tokio::test]
    async fn a_put_ends_at_its_limit_however_long_the_server_asks_it_to_wait() {
        let limited =
            json!({"errcode": "M_LIMIT_EXCEEDED", "error": "x", "retry_after_ms": 600_000});
        let (client, seen) = client_on(vec![(PUT, 429, limited), (PUT, 200, json!({}))]).await;
        let (content, limit) = (json!({"a": 1}), Duration::from_millis(300));
        let put = put_within(&client, "x.y", &content, limit);
        let err = timeout(put, Duration::from_secs(5))
            .await
            .expect("the write outlived its limit")
            .unwrap_err();
        assert_eq!(request_failed(&err).kind, FailureKind::Timeout);
        assert_eq!(requests(&seen).len(), 1);
    }

    #[tokio::test]
    async fn a_put_tries_five_times() {
        let mut answers = vec![(PUT, 502, unavailable()); 5];
        answers.push((PUT, 200, json!({})));
        let (client, seen) = client_on(answers).await;
        assert!(put(&client, "x.y", &json!({"a": 1})).await.is_err());
        assert_eq!(
            requests(&seen).len(),
            5,
            "a sixth attempt would have met the 200"
        );
    }
}
