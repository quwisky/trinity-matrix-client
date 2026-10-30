//! Engine failures as plain data, mirroring `EngineFailure` in
//! `libs/util/matrix/src/lib/engine-result.ts`.

use matrix_sdk::{
    Error, HttpError, RefreshTokenError, RumaApiError,
    authentication::oauth::{
        OAuthError,
        error::{BasicErrorResponseType, RequestTokenError},
    },
    ruma::api::error::{ErrorBody, ErrorKind, FromHttpResponseError, RetryAfter},
};
use serde::{Serialize, Serializer, ser::SerializeStruct};
use ts_rs::TS;

const DTO: &str = "util/matrix/src/lib/rust-dto/";
const MAX_RETRY_AFTER_MS: u128 = 24 * 60 * 60 * 1000;

/// `MatrixRequestFailureKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = DTO)]
pub enum FailureKind {
    Network,
    Timeout,
    Authentication,
    Permission,
    RateLimit,
    Server,
    Http,
    Unexpected,
}

/// `MatrixRequestFailureMetadata`: only metadata that is safe to log.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO, optional_fields)]
pub struct Diagnostic {
    pub kind: FailureKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errcode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u32>,
}

impl Diagnostic {
    pub fn new(kind: FailureKind) -> Self {
        Self {
            kind,
            http_status: None,
            errcode: None,
            retry_after_ms: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = DTO)]
pub enum DiscoveryFailureReason {
    Invalid,
    GenericFailure,
    InvalidHsBaseUrl,
    InvalidHomeserver,
    UnsupportedHomeserverSpecVersion,
    MissingWellknown,
    InvalidJson,
}

/// Marks a failed token refresh, worded apart from a plain network failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = DTO)]
pub enum RefreshCause {
    SessionRefresh,
}

/// The `code` and `params` of an [`EngineFailure`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FailureCode {
    NotSignedIn,
    DiscoveryFailed {
        domain: String,
        reason: Option<DiscoveryFailureReason>,
    },
    RequestFailed {
        cause: Option<RefreshCause>,
        /// Text the homeserver wrote for a person to read.
        server_message: Option<String>,
    },
}

/// A failure as plain data: a code and parameters, never text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(into = "WireFailure")]
pub struct EngineFailure {
    pub kind: FailureKind,
    pub diagnostic: Diagnostic,
    pub code: FailureCode,
}

// The JSON form of an `EngineFailure`: serde cannot nest the code's fields under `params`.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO, rename = "EngineFailure")]
struct WireFailure {
    kind: FailureKind,
    diagnostic: Diagnostic,
    #[serde(flatten)]
    code: WireCode,
}

#[derive(Serialize, TS)]
#[serde(tag = "code", rename_all = "kebab-case")]
enum WireCode {
    NotSignedIn,
    DiscoveryFailed {
        params: DiscoveryParams,
    },
    RequestFailed {
        // The js-sdk adapters omit empty params rather than send `{}`.
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        params: Option<RequestParams>,
    },
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO, optional_fields)]
struct DiscoveryParams {
    domain: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<DiscoveryFailureReason>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO, optional_fields)]
struct RequestParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    cause: Option<RefreshCause>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_message: Option<String>,
}

impl From<EngineFailure> for WireFailure {
    fn from(failure: EngineFailure) -> Self {
        let code = match failure.code {
            FailureCode::NotSignedIn => WireCode::NotSignedIn,
            FailureCode::DiscoveryFailed { domain, reason } => WireCode::DiscoveryFailed {
                params: DiscoveryParams { domain, reason },
            },
            FailureCode::RequestFailed {
                cause,
                server_message,
            } => WireCode::RequestFailed {
                params: (cause.is_some() || server_message.is_some()).then_some(RequestParams {
                    cause,
                    server_message,
                }),
            },
        };
        Self {
            kind: failure.kind,
            diagnostic: failure.diagnostic,
            code,
        }
    }
}

/// The outcome of an engine command: expected failures are values, faults error the stream.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EngineResult<T> {
    Ok(T),
    Err(EngineFailure),
}

impl<T: Serialize> Serialize for EngineResult<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut result = serializer.serialize_struct("EngineResult", 2)?;
        match self {
            Self::Ok(value) => {
                result.serialize_field("ok", &true)?;
                result.serialize_field("value", value)?;
            }
            Self::Err(failure) => {
                result.serialize_field("ok", &false)?;
                result.serialize_field("failure", failure)?;
            }
        }
        result.end()
    }
}

/// `NOT_SIGNED_IN`.
pub fn not_signed_in() -> EngineFailure {
    EngineFailure {
        kind: FailureKind::Unexpected,
        diagnostic: Diagnostic::new(FailureKind::Unexpected),
        code: FailureCode::NotSignedIn,
    }
}

/// A `request-failed` failure for `err`, classified like `describeMatrixRequestFailure`.
pub fn request_failed(err: &Error) -> EngineFailure {
    let (kind, diagnostic) = classify(err);
    let refresh = matches!(err, Error::Http(http) if session_refresh(http));
    EngineFailure {
        kind,
        diagnostic,
        code: FailureCode::RequestFailed {
            cause: refresh.then_some(RefreshCause::SessionRefresh),
            server_message: None,
        },
    }
}

pub fn classify(err: &Error) -> (FailureKind, Diagnostic) {
    match err {
        Error::Http(http) => classify_http(http),
        _ => bare(FailureKind::Unexpected),
    }
}

/// Mirrors `describeMatrixRequestFailure` in `libs/util/matrix/src/lib/request-failure.ts`.
pub fn classify_http(err: &HttpError) -> (FailureKind, Diagnostic) {
    match err {
        HttpError::Cached(inner) => classify_http(inner),
        HttpError::Reqwest(error) if error.is_timeout() => bare(FailureKind::Timeout),
        HttpError::RefreshToken(error) if refresh_logs_out(error) => {
            bare(FailureKind::Authentication)
        }
        HttpError::RefreshToken(_) | HttpError::Reqwest(_) => bare(FailureKind::Network),
        HttpError::Api(error) => match error.as_ref() {
            FromHttpResponseError::Server(RumaApiError::MatrixError(error)) => {
                let retry_after = match error.error_kind() {
                    Some(ErrorKind::LimitExceeded(data)) => data.retry_after.as_ref(),
                    _ => None,
                };
                classify_response(
                    error.status_code.as_u16(),
                    errcode(&error.body),
                    retry_after,
                )
            }
            // An interactive-auth challenge is always a 401.
            FromHttpResponseError::Server(RumaApiError::AuthResponse(info)) => {
                let errcode = info
                    .auth_error
                    .as_ref()
                    .map(|e| e.kind.errcode().to_string());
                classify_response(401, errcode, None)
            }
            _ => bare(FailureKind::Unexpected),
        },
        HttpError::IntoHttp(_) => bare(FailureKind::Unexpected),
    }
}

fn bare(kind: FailureKind) -> (FailureKind, Diagnostic) {
    (kind, Diagnostic::new(kind))
}

/// Whether the SDK ends the session for this refresh failure, as `client/futures.rs` does by
/// broadcasting `SessionChange::UnknownToken`.
fn refresh_logs_out(err: &RefreshTokenError) -> bool {
    match err {
        RefreshTokenError::OAuth(error) => matches!(
            error.as_ref(),
            OAuthError::RefreshToken(RequestTokenError::ServerResponse(response))
                if *response.error() == BasicErrorResponseType::InvalidGrant
        ),
        RefreshTokenError::RefreshTokenRequired | RefreshTokenError::MatrixAuth(_) => true,
    }
}

fn session_refresh(err: &HttpError) -> bool {
    match err {
        HttpError::Cached(inner) => session_refresh(inner),
        HttpError::RefreshToken(error) => !refresh_logs_out(error),
        _ => false,
    }
}

fn errcode(body: &ErrorBody) -> Option<String> {
    match body {
        ErrorBody::Standard(body) => Some(body.kind.errcode().to_string()),
        ErrorBody::Json(json) => json.get("errcode")?.as_str().map(Into::into),
        ErrorBody::NotJson { .. } => None,
    }
}

fn classify_response(
    status: u16,
    errcode: Option<String>,
    retry_after: Option<&RetryAfter>,
) -> (FailureKind, Diagnostic) {
    let http_status = (100..=599).contains(&status).then_some(status);
    // `isRateLimitError` in the js-sdk, which reads the errcode before it is checked for logging.
    let rate_limit = match errcode.as_deref() {
        Some("M_LIMIT_EXCEEDED") => true,
        None | Some("M_UNKNOWN") => status == 429,
        Some(_) => false,
    };
    let errcode = errcode.filter(|code| safe_errcode(code));
    let code = errcode.as_deref();
    let kind = if matches!(code, Some("M_UNKNOWN_TOKEN" | "M_MISSING_TOKEN")) {
        // Matrix also uses 401 for interactive-auth challenges: only these codes mean the
        // login has expired.
        FailureKind::Authentication
    } else if http_status == Some(403) || code == Some("M_FORBIDDEN") {
        FailureKind::Permission
    } else if rate_limit {
        FailureKind::RateLimit
    } else if http_status.is_some_and(|status| status >= 500) {
        FailureKind::Server
    } else {
        FailureKind::Http
    };
    let diagnostic = Diagnostic {
        kind,
        http_status,
        errcode,
        retry_after_ms: retry_after
            .filter(|_| kind == FailureKind::RateLimit)
            .and_then(retry_after_ms),
    };
    (kind, diagnostic)
}

fn retry_after_ms(retry_after: &RetryAfter) -> Option<u32> {
    let delay = match retry_after {
        RetryAfter::Delay(delay) => *delay,
        RetryAfter::DateTime(at) => at.duration_since(std::time::SystemTime::now()).ok()?,
    };
    let ms = delay.as_millis();
    (ms <= MAX_RETRY_AFTER_MS).then_some(ms as u32)
}

/// `safeErrcode`: an errcode is written to logs, so it must look like one.
fn safe_errcode(code: &str) -> bool {
    let mut chars = code.chars();
    code.len() <= 128
        && chars.next().is_some_and(|c| c.is_ascii_uppercase())
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || "_.-".contains(c))
}

#[cfg(test)]
mod tests {
    use std::{
        sync::Arc,
        time::{Duration, SystemTime},
    };

    use matrix_sdk::{
        Client, Error, HttpError, RefreshTokenError, RumaApiError,
        authentication::oauth::{
            OAuthError,
            error::{BasicErrorResponseType, RequestTokenError, StandardErrorResponse},
        },
        config::RequestConfig,
        ruma::{
            api::{
                EndpointError,
                error::{FromHttpResponseError, RetryAfter},
            },
            exports::http,
        },
    };
    use serde_json::{Value, json};

    use super::*;

    fn to_json(value: impl serde::Serialize) -> Value {
        serde_json::to_value(value).unwrap()
    }

    fn discovery_failed(reason: Option<DiscoveryFailureReason>) -> EngineFailure {
        EngineFailure {
            kind: FailureKind::Unexpected,
            diagnostic: Diagnostic::new(FailureKind::Unexpected),
            code: FailureCode::DiscoveryFailed {
                domain: "x.invalid".into(),
                reason,
            },
        }
    }

    fn request_failed_with(cause: Option<RefreshCause>, server_message: Option<&str>) -> Value {
        to_json(EngineFailure {
            kind: FailureKind::Network,
            diagnostic: Diagnostic::new(FailureKind::Network),
            code: FailureCode::RequestFailed {
                cause,
                server_message: server_message.map(Into::into),
            },
        })
    }

    #[test]
    fn not_signed_in_matches_the_typescript_constant() {
        assert_eq!(
            to_json(not_signed_in()),
            json!({"kind": "unexpected", "code": "not-signed-in", "diagnostic": {"kind": "unexpected"}})
        );
    }

    #[test]
    fn discovery_failed_nests_its_params_and_omits_an_absent_reason() {
        assert_eq!(
            to_json(discovery_failed(None)),
            json!({
                "kind": "unexpected",
                "code": "discovery-failed",
                "params": {"domain": "x.invalid"},
                "diagnostic": {"kind": "unexpected"},
            })
        );
        assert_eq!(
            to_json(discovery_failed(Some(
                DiscoveryFailureReason::MissingWellknown
            )))["params"],
            json!({"domain": "x.invalid", "reason": "missing-wellknown"})
        );
    }

    #[test]
    fn request_failed_omits_params_when_it_has_none() {
        assert_eq!(
            request_failed_with(None, None),
            json!({"kind": "network", "code": "request-failed", "diagnostic": {"kind": "network"}})
        );
        assert_eq!(
            request_failed_with(Some(RefreshCause::SessionRefresh), None)["params"],
            json!({"cause": "session-refresh"})
        );
        assert_eq!(
            request_failed_with(None, Some("Too weak"))["params"],
            json!({"serverMessage": "Too weak"})
        );
    }

    #[test]
    fn a_diagnostic_writes_only_the_fields_it_has() {
        let diagnostic = Diagnostic {
            kind: FailureKind::RateLimit,
            http_status: Some(429),
            errcode: Some("M_LIMIT_EXCEEDED".into()),
            retry_after_ms: Some(1500),
        };
        assert_eq!(
            to_json(diagnostic),
            json!({"kind": "rate-limit", "httpStatus": 429, "errcode": "M_LIMIT_EXCEEDED", "retryAfterMs": 1500})
        );
    }

    #[test]
    fn an_engine_result_tags_itself_with_ok() {
        assert_eq!(
            to_json(EngineResult::Ok(json!({"a": 1}))),
            json!({"ok": true, "value": {"a": 1}})
        );
        assert_eq!(
            to_json(EngineResult::<Value>::Err(not_signed_in())),
            json!({"ok": false, "failure": to_json(not_signed_in())})
        );
    }

    fn with(
        kind: FailureKind,
        http_status: u16,
        errcode: Option<&str>,
        retry_after_ms: Option<u32>,
    ) -> (FailureKind, Diagnostic) {
        let diagnostic = Diagnostic {
            kind,
            http_status: Some(http_status),
            errcode: errcode.map(Into::into),
            retry_after_ms,
        };
        (kind, diagnostic)
    }

    /// An error response parsed the way the SDK parses one.
    fn response(status: u16, body: &str, retry_after: Option<&str>) -> HttpError {
        let mut builder = http::Response::builder().status(status);
        if let Some(value) = retry_after {
            builder = builder.header(http::header::RETRY_AFTER, value);
        }
        let response = builder.body(body.as_bytes()).unwrap();
        FromHttpResponseError::Server(RumaApiError::from_http_response(response)).into()
    }

    fn matrix_error(status: u16, errcode: &str) -> HttpError {
        response(
            status,
            &json!({"errcode": errcode, "error": "…"}).to_string(),
            None,
        )
    }

    /// The error the SDK returns for a request to `url`.
    async fn request_error(url: &str, timeout: Duration) -> HttpError {
        let client = Client::builder().homeserver_url(url).build().await.unwrap();
        let config = RequestConfig::new().disable_retry().timeout(timeout);
        client
            .fetch_server_versions(Some(config))
            .await
            .unwrap_err()
    }

    fn refresh_error(error: RefreshTokenError) -> HttpError {
        HttpError::RefreshToken(error)
    }

    fn oauth_refresh_error(error: OAuthError) -> HttpError {
        refresh_error(RefreshTokenError::OAuth(Arc::new(error)))
    }

    fn invalid_grant() -> HttpError {
        oauth_refresh_error(OAuthError::RefreshToken(RequestTokenError::ServerResponse(
            StandardErrorResponse::new(BasicErrorResponseType::InvalidGrant, None, None),
        )))
    }

    fn refresh_cause(failure: EngineFailure) -> Option<RefreshCause> {
        match failure.code {
            FailureCode::RequestFailed { cause, .. } => cause,
            code => panic!("not request-failed: {code:?}"),
        }
    }

    #[tokio::test]
    async fn a_request_timeout_is_timeout() {
        let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", silent.local_addr().unwrap());
        let error = request_error(&url, Duration::from_millis(200)).await;
        assert_eq!(classify_http(&error), bare(FailureKind::Timeout));
    }

    #[test]
    fn a_refresh_failure_that_logs_out_is_authentication() {
        let rejected = Arc::new(matrix_error(401, "M_UNKNOWN_TOKEN"));
        for error in [
            invalid_grant(),
            refresh_error(RefreshTokenError::MatrixAuth(rejected)),
        ] {
            assert_eq!(classify_http(&error), bare(FailureKind::Authentication));
            assert_eq!(refresh_cause(request_failed(&error.into())), None);
        }
    }

    #[test]
    fn any_other_refresh_failure_is_network_with_a_session_refresh_cause() {
        let error = oauth_refresh_error(OAuthError::NotAuthenticated);
        assert_eq!(classify_http(&error), bare(FailureKind::Network));
        let failure = request_failed(&error.into());
        assert_eq!(failure.kind, FailureKind::Network);
        assert_eq!(refresh_cause(failure), Some(RefreshCause::SessionRefresh));
    }

    #[tokio::test]
    async fn a_connection_error_is_network() {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let error =
            request_error(&format!("http://127.0.0.1:{port}"), Duration::from_secs(5)).await;
        assert_eq!(classify_http(&error), bare(FailureKind::Network));
        assert_eq!(refresh_cause(request_failed(&error.into())), None);
    }

    #[test]
    fn a_token_errcode_is_authentication() {
        for errcode in ["M_UNKNOWN_TOKEN", "M_MISSING_TOKEN"] {
            assert_eq!(
                classify_http(&matrix_error(401, errcode)),
                with(FailureKind::Authentication, 401, Some(errcode), None)
            );
        }
    }

    #[test]
    fn a_403_or_m_forbidden_is_permission() {
        assert_eq!(
            classify_http(&response(403, "<html>", None)),
            with(FailureKind::Permission, 403, None, None)
        );
        // A refused interactive-auth stage carries its errcode in the 401 challenge.
        let challenge = json!({"flows": [], "errcode": "M_FORBIDDEN", "error": "…"});
        assert_eq!(
            classify_http(&response(401, &challenge.to_string(), None)),
            with(FailureKind::Permission, 401, Some("M_FORBIDDEN"), None)
        );
        // Permission wins over a rate limit, and only a rate limit reports its delay.
        let limited = json!({"errcode": "M_LIMIT_EXCEEDED", "error": "…"});
        assert_eq!(
            classify_http(&response(403, &limited.to_string(), Some("3"))),
            with(FailureKind::Permission, 403, Some("M_LIMIT_EXCEEDED"), None)
        );
    }

    #[test]
    fn a_rate_limit_is_rate_limit_with_its_retry_delay() {
        let limited = |body: Value, retry_after| response(429, &body.to_string(), retry_after);
        let errcode = json!({"errcode": "M_LIMIT_EXCEEDED", "error": "…"});
        assert_eq!(
            classify_http(&limited(errcode.clone(), Some("3"))),
            with(
                FailureKind::RateLimit,
                429,
                Some("M_LIMIT_EXCEEDED"),
                Some(3000)
            )
        );
        let in_body = json!({"errcode": "M_LIMIT_EXCEEDED", "error": "…", "retry_after_ms": 1500});
        assert_eq!(
            classify_http(&limited(in_body, None)).1.retry_after_ms,
            Some(1500)
        );
        let soon = RetryAfter::DateTime(SystemTime::now() + Duration::from_secs(60));
        let date = http::HeaderValue::try_from(&soon).unwrap();
        let delay = classify_http(&limited(errcode.clone(), Some(date.to_str().unwrap())))
            .1
            .retry_after_ms
            .unwrap();
        assert!((58_000..=60_000).contains(&delay), "{delay}");
        // More than a day is not a delay worth reporting.
        assert_eq!(
            classify_http(&limited(errcode, Some("90000"))),
            with(FailureKind::RateLimit, 429, Some("M_LIMIT_EXCEEDED"), None)
        );
        assert_eq!(
            classify_http(&response(429, "slow down", None)),
            with(FailureKind::RateLimit, 429, None, None)
        );
        assert_eq!(
            classify_http(&matrix_error(429, "M_UNKNOWN")),
            with(FailureKind::RateLimit, 429, Some("M_UNKNOWN"), None)
        );
    }

    #[test]
    fn a_429_with_another_errcode_is_http() {
        assert_eq!(
            classify_http(&matrix_error(429, "M_NOT_FOUND")),
            with(FailureKind::Http, 429, Some("M_NOT_FOUND"), None)
        );
        // `isRateLimitError` reads the errcode before it is checked for logging.
        assert_eq!(
            classify_http(&matrix_error(429, "secret: hunter2")),
            with(FailureKind::Http, 429, None, None)
        );
    }

    #[test]
    fn a_status_of_500_or_more_is_server() {
        assert_eq!(
            classify_http(&response(502, "<html>", None)),
            with(FailureKind::Server, 502, None, None)
        );
        assert_eq!(
            classify_http(&matrix_error(500, "M_UNKNOWN")),
            with(FailureKind::Server, 500, Some("M_UNKNOWN"), None)
        );
    }

    #[test]
    fn any_other_http_error_is_http() {
        assert_eq!(
            classify_http(&matrix_error(404, "M_NOT_FOUND")),
            with(FailureKind::Http, 404, Some("M_NOT_FOUND"), None)
        );
        // An errcode without the `error` text the spec makes optional.
        assert_eq!(
            classify_http(&response(400, r#"{"errcode":"M_BAD_JSON"}"#, None)),
            with(FailureKind::Http, 400, Some("M_BAD_JSON"), None)
        );
        // An errcode that is not one is not written to a diagnostic.
        assert_eq!(
            classify_http(&matrix_error(400, "secret: hunter2")),
            with(FailureKind::Http, 400, None, None)
        );
    }

    #[test]
    fn anything_else_is_unexpected() {
        let malformed = serde_json::from_str::<()>("x").unwrap_err();
        let undecodable = HttpError::from(FromHttpResponseError::<RumaApiError>::from(malformed));
        assert_eq!(classify_http(&undecodable), bare(FailureKind::Unexpected));
        assert_eq!(
            classify(&Error::InsufficientData),
            bare(FailureKind::Unexpected)
        );
        let failure = request_failed(&Error::InsufficientData);
        assert_eq!(failure.kind, FailureKind::Unexpected);
        assert_eq!(refresh_cause(failure), None);
    }

    #[test]
    fn classify_reads_an_http_error_through_the_sdk_error() {
        let error = Error::from(matrix_error(403, "M_FORBIDDEN"));
        assert_eq!(
            classify(&error),
            with(FailureKind::Permission, 403, Some("M_FORBIDDEN"), None)
        );
    }

    #[test]
    fn classify_http_reads_through_a_cached_error() {
        let cached = HttpError::Cached(Arc::new(oauth_refresh_error(OAuthError::NotAuthenticated)));
        assert_eq!(classify_http(&cached), bare(FailureKind::Network));
        assert_eq!(
            refresh_cause(request_failed(&cached.into())),
            Some(RefreshCause::SessionRefresh)
        );
    }
}
