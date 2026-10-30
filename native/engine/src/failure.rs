//! Engine failures as plain data, mirroring `EngineFailure` in
//! `libs/util/matrix/src/lib/engine-result.ts`.

use matrix_sdk::{
    Error, HttpError, RefreshTokenError, RumaApiError,
    authentication::oauth::{
        OAuthError,
        error::{BasicErrorResponseType, RequestTokenError},
    },
    ruma::{
        api::{
            EndpointError,
            error::{ErrorBody, ErrorKind, FromHttpResponseError, RetryAfter},
        },
        exports::http,
    },
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

/// `AccountStartFailureReason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = DTO)]
pub enum AccountStartFailureReason {
    ReauthenticationRequired,
    TransientNetwork,
    CryptoFailure,
    CryptoStoreKeyLost,
    SecureStorageUnavailable,
}

/// `UiaChallenge` as the js adapter's `uiaChallengeOf` builds it: no stage parameters.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = DTO, optional_fields)]
pub struct UiaChallengeDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    pub flows: Vec<UiaFlowDto>,
    pub completed: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = DTO)]
pub struct UiaFlowDto {
    pub stages: Vec<String>,
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
    AccountNotLive,
    AccountStartFailed {
        reason: AccountStartFailureReason,
    },
    UiaRequired {
        challenge: UiaChallengeDto,
    },
    Unsupported,
    Forbidden,
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
    AccountNotLive,
    AccountStartFailed {
        #[ts(inline)]
        params: AccountStartParams,
    },
    UiaRequired {
        #[ts(inline)]
        params: UiaParams,
    },
    Unsupported,
    Forbidden,
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

#[derive(Serialize, TS)]
struct AccountStartParams {
    reason: AccountStartFailureReason,
}

#[derive(Serialize, TS)]
struct UiaParams {
    challenge: UiaChallengeDto,
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
            FailureCode::AccountNotLive => WireCode::AccountNotLive,
            FailureCode::AccountStartFailed { reason } => WireCode::AccountStartFailed {
                params: AccountStartParams { reason },
            },
            FailureCode::UiaRequired { challenge } => WireCode::UiaRequired {
                params: UiaParams { challenge },
            },
            FailureCode::Unsupported => WireCode::Unsupported,
            FailureCode::Forbidden => WireCode::Forbidden,
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

/// `ACCOUNT_NOT_LIVE` in the js adapter.
pub fn account_not_live() -> EngineFailure {
    EngineFailure {
        kind: FailureKind::Unexpected,
        diagnostic: Diagnostic::new(FailureKind::Unexpected),
        code: FailureCode::AccountNotLive,
    }
}

pub fn account_start_failed(
    reason: AccountStartFailureReason,
    kind: FailureKind,
    diagnostic: Diagnostic,
) -> EngineFailure {
    EngineFailure {
        kind,
        diagnostic,
        code: FailureCode::AccountStartFailed { reason },
    }
}

/// The js adapter's `requestFailure`: a UIA challenge, a missing endpoint (`M_UNRECOGNIZED`, or a
/// Matrix 404/405 that is not `M_NOT_FOUND`), a policy refusal (`M_FORBIDDEN`), or else
/// [`request_failed`].
pub fn request_failure(err: &Error) -> EngineFailure {
    let server_error = match err {
        Error::Http(http) => server_error(http),
        _ => None,
    };
    let code = match server_error {
        Some(RumaApiError::AuthResponse(info)) => FailureCode::UiaRequired {
            challenge: UiaChallengeDto {
                session: info.session.clone(),
                flows: info
                    .flows
                    .iter()
                    .map(|flow| UiaFlowDto {
                        stages: flow.stages.iter().map(|s| s.as_str().into()).collect(),
                    })
                    .collect(),
                completed: info.completed.iter().map(|s| s.as_str().into()).collect(),
            },
        },
        // A body that is not JSON is the js-sdk's `HTTPError`, not a `MatrixError`.
        Some(RumaApiError::MatrixError(error))
            if !matches!(error.body, ErrorBody::NotJson { .. }) =>
        {
            let errcode = errcode(&error.body);
            let missing = errcode.as_deref() == Some("M_UNRECOGNIZED")
                || (matches!(error.status_code.as_u16(), 404 | 405)
                    && errcode.as_deref() != Some("M_NOT_FOUND"));
            if missing {
                FailureCode::Unsupported
            } else if errcode.as_deref() == Some("M_FORBIDDEN") {
                FailureCode::Forbidden
            } else {
                return request_failed(err);
            }
        }
        _ => return request_failed(err),
    };
    let (kind, diagnostic) = classify(err);
    EngineFailure {
        kind,
        diagnostic,
        code,
    }
}

/// The error the SDK makes of a non-2xx answer, for a request the engine sent itself.
pub fn http_error_from_response(status: http::StatusCode, body: &[u8]) -> HttpError {
    let mut response = http::Response::new(body);
    *response.status_mut() = status;
    FromHttpResponseError::Server(RumaApiError::from_http_response(response)).into()
}

/// The homeserver's error response, read through a cached error as [`classify_http`] does.
fn server_error(err: &HttpError) -> Option<&RumaApiError> {
    match err {
        HttpError::Cached(inner) => server_error(inner),
        _ => err.as_ruma_api_error(),
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

/// Whether the provider refused the refresh, which ends the session (js
/// `TokenRefreshLogoutError`): OAuth's `invalid_grant`, a Matrix refresh answered
/// `M_UNKNOWN_TOKEN`, or no refresh token. Any other failure is transient.
pub(crate) fn refresh_logs_out(err: &RefreshTokenError) -> bool {
    match err {
        RefreshTokenError::OAuth(error) => matches!(
            error.as_ref(),
            OAuthError::RefreshToken(RequestTokenError::ServerResponse(response))
                if *response.error() == BasicErrorResponseType::InvalidGrant
        ),
        RefreshTokenError::MatrixAuth(error) => {
            matches!(
                error.client_api_error_kind(),
                Some(ErrorKind::UnknownToken(_))
            )
        }
        RefreshTokenError::RefreshTokenRequired => true,
    }
}

/// Whether `err` is a refresh the provider refused.
pub(crate) fn refused_refresh(err: &Error) -> bool {
    match err {
        Error::Http(http) => {
            matches!(http.as_ref(), HttpError::RefreshToken(e) if refresh_logs_out(e))
        }
        _ => false,
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
    fn account_not_live_matches_the_typescript_constant() {
        assert_eq!(
            to_json(account_not_live()),
            json!({"kind": "unexpected", "code": "account-not-live", "diagnostic": {"kind": "unexpected"}})
        );
    }

    #[test]
    fn the_session_codes_write_their_params() {
        let unexpected = || Diagnostic::new(FailureKind::Unexpected);
        assert_eq!(
            to_json(account_start_failed(
                AccountStartFailureReason::CryptoStoreKeyLost,
                FailureKind::Unexpected,
                unexpected()
            )),
            json!({
                "kind": "unexpected",
                "code": "account-start-failed",
                "diagnostic": {"kind": "unexpected"},
                "params": {"reason": "crypto-store-key-lost"},
            })
        );
        let challenge = json!({"session": "s", "flows": [{"stages": ["m.login.password"]}]});
        assert_eq!(
            to_json(request_failure(
                &response(401, &challenge.to_string(), None).into()
            )),
            json!({
                "kind": "http",
                "code": "uia-required",
                "diagnostic": {"kind": "http", "httpStatus": 401},
                "params": {"challenge": {
                    "session": "s",
                    "flows": [{"stages": ["m.login.password"]}],
                    "completed": [],
                }},
            })
        );
        for (code, name) in [
            (FailureCode::Unsupported, "unsupported"),
            (FailureCode::Forbidden, "forbidden"),
        ] {
            let failure = EngineFailure {
                kind: FailureKind::Unexpected,
                diagnostic: unexpected(),
                code,
            };
            assert_eq!(
                to_json(failure),
                json!({"kind": "unexpected", "code": name, "diagnostic": {"kind": "unexpected"}})
            );
        }
    }

    #[test]
    fn request_failure_sorts_server_errors_like_the_js_adapter() {
        let code = |error: HttpError| request_failure(&error.into()).code;
        let challenge = json!({"flows": [{"stages": ["m.login.password"]}], "session": "s"});
        assert_eq!(
            code(response(401, &challenge.to_string(), None)),
            FailureCode::UiaRequired {
                challenge: UiaChallengeDto {
                    session: Some("s".into()),
                    flows: vec![UiaFlowDto {
                        stages: vec!["m.login.password".into()]
                    }],
                    completed: vec![],
                }
            }
        );
        let request_failed = FailureCode::RequestFailed {
            cause: None,
            server_message: None,
        };
        for (error, expected) in [
            (
                matrix_error(400, "M_UNRECOGNIZED"),
                FailureCode::Unsupported,
            ),
            (
                matrix_error(404, "M_UNRECOGNIZED"),
                FailureCode::Unsupported,
            ),
            (matrix_error(405, "M_UNKNOWN"), FailureCode::Unsupported),
            (response(404, "{}", None), FailureCode::Unsupported),
            (matrix_error(404, "M_NOT_FOUND"), request_failed.clone()),
            (response(404, "<html>", None), request_failed.clone()),
            (matrix_error(403, "M_FORBIDDEN"), FailureCode::Forbidden),
            (matrix_error(401, "M_UNKNOWN_TOKEN"), request_failed.clone()),
        ] {
            let status = error.as_ruma_api_error().map(ToString::to_string);
            assert_eq!(code(error), expected, "{status:?}");
        }
        let expired = request_failure(&matrix_error(401, "M_UNKNOWN_TOKEN").into());
        assert_eq!(
            expired.diagnostic.errcode.as_deref(),
            Some("M_UNKNOWN_TOKEN")
        );
    }

    #[test]
    fn request_failure_reads_through_a_cached_error() {
        let cached = HttpError::Cached(Arc::new(matrix_error(404, "M_UNRECOGNIZED")));
        assert_eq!(
            request_failure(&cached.into()).code,
            FailureCode::Unsupported
        );
    }

    #[tokio::test]
    async fn request_failure_of_a_connection_error_is_a_network_request_failure() {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let error =
            request_error(&format!("http://127.0.0.1:{port}"), Duration::from_secs(5)).await;
        let failure = request_failure(&error.into());
        assert_eq!(failure.kind, FailureKind::Network);
        assert!(
            matches!(failure.code, FailureCode::RequestFailed { .. }),
            "{failure:?}"
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
    fn a_matrix_refresh_the_server_did_not_refuse_is_transient() {
        let unavailable = Arc::new(matrix_error(502, "M_UNKNOWN"));
        let error = || refresh_error(RefreshTokenError::MatrixAuth(Arc::clone(&unavailable)));
        assert_eq!(classify_http(&error()), bare(FailureKind::Network));
        let failure = request_failure(&error().into());
        assert_eq!(refresh_cause(failure), Some(RefreshCause::SessionRefresh));
    }

    #[test]
    fn any_other_refresh_failure_is_network_with_a_session_refresh_cause() {
        let error = || oauth_refresh_error(OAuthError::NotAuthenticated);
        assert_eq!(classify_http(&error()), bare(FailureKind::Network));
        let failure = request_failed(&error().into());
        assert_eq!(failure.kind, FailureKind::Network);
        assert_eq!(refresh_cause(failure), Some(RefreshCause::SessionRefresh));
        // As the js adapter's `requestFailure` marks a `TokenRefreshError` (S7).
        let sorted = request_failure(&error().into());
        assert_eq!(refresh_cause(sorted), Some(RefreshCause::SessionRefresh));
    }

    #[test]
    fn http_error_from_response_keeps_the_unknown_token_kind() {
        let body = json!({"errcode": "M_UNKNOWN_TOKEN", "error": "x", "soft_logout": true});
        let error =
            http_error_from_response(http::StatusCode::UNAUTHORIZED, body.to_string().as_bytes());
        assert!(matches!(
            error.client_api_error_kind(),
            Some(ErrorKind::UnknownToken(data)) if data.soft_logout
        ));
        assert_eq!(
            classify_http(&error),
            with(
                FailureKind::Authentication,
                401,
                Some("M_UNKNOWN_TOKEN"),
                None
            )
        );
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
