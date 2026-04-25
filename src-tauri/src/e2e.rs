//! E2E flow runner (substrate v6).
//!
//! Composes `http_fetch` into a sequence of stateful steps with variable
//! extraction between them, plus a small assertion DSL. The strongest
//! runtime-correctness signal Prism produces: a feature is "done" when
//! the recorded flow that exercises it (login → action → verify) passes
//! all assertions.
//!
//! Design rules:
//!   - Substrate calls are deterministic for a given repo + dev-server
//!     state. The LLM does not influence the flow's pass/fail.
//!   - Read-only by intent, but flows DO touch user state (POST,
//!     DELETE). The agent gates these the same way it gates http_fetch:
//!     by only calling them in modes (audit/build) where the user has
//!     opted in.
//!   - Transport failures (timeouts, connection refused) are substrate
//!     failures (`ok=false` on the affected step). They do NOT count as
//!     "the endpoint is broken" — exactly the same carve-out http_fetch
//!     uses, propagated step-by-step.
//!   - Assertions are pure functions of the response. Variable
//!     extraction is pure too. Templating is `{{name}}`-only — no
//!     conditional logic, no math, no Turing-completeness escape valve.
//!
//! Source attribution: every diagnostic emitted by this cell carries
//! `source = "runtime"` so the grader graduates findings to confirmed.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Default timeout for one flow step. The flow as a whole gets the
/// step-count-aware budget computed in `run_flow`.
const STEP_DEFAULT_TIMEOUT_SECS: u64 = 10;

/// Maximum bytes of response body retained per step. Caps a runaway
/// payload (full HTML page, large JSON dump) so the model's tool result
/// stays within budget.
const STEP_MAX_BODY_BYTES: usize = 16 * 1024;

/// Hard cap on the number of steps in one flow. Above this, the cell
/// rejects the spec — keeps the model from constructing a 1000-step
/// flow that would saturate the agent's tool-round budget.
const MAX_STEPS: usize = 25;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// One assertion the user (via the LLM) wants checked against a step's
/// response. The variants are deliberately narrow so a future v2 can
/// add more without breaking the v1 grammar.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Assertion {
    /// Response status code must match. Accepts an exact integer
    /// (`200`, `404`) or a class like `2xx`, `3xx`, `4xx`, `5xx`.
    Status { equals: String },
    /// Response body (decoded as UTF-8 lossy) must contain the literal.
    BodyContains { value: String },
    /// JSON path on the parsed body must equal the given JSON value.
    /// Path syntax is dot-segments only (e.g. `user.email`, `data.0.id`).
    JsonEq { path: String, value: Value },
}

/// One value extracted from a step's response and stored in the flow's
/// variable map for use in subsequent steps' templates.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Extract {
    /// Variable name. Becomes available as `{{name}}` in later steps.
    pub name: String,
    /// Where to read the value from.
    #[serde(flatten)]
    pub from: ExtractFrom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "from", rename_all = "snake_case")]
pub enum ExtractFrom {
    /// Pull a JSON path out of the parsed response body. Dot-segments
    /// only (`user.email`, `tokens.0.value`).
    Json { path: String },
    /// Pull a response header by name (case-insensitive).
    Header { name: String },
}

/// One step in the flow.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowStep {
    /// Optional human-readable label; falls back to "step N" in reports.
    #[serde(default)]
    pub name: Option<String>,
    /// HTTP method. Defaults to GET when omitted.
    #[serde(default)]
    pub method: Option<String>,
    /// URL or URL template (supports `{{var}}`).
    pub url: String,
    /// Request headers, all values may contain `{{var}}`.
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// Request body, may contain `{{var}}`.
    #[serde(default)]
    pub body: Option<String>,
    /// Optional per-step timeout in seconds.
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// Optional values to extract from the response.
    #[serde(default)]
    pub extract: Vec<Extract>,
    /// Optional assertions to evaluate against the response.
    #[serde(default)]
    pub assert: Vec<Assertion>,
}

/// Outcome of one flow step.
#[derive(Debug, Clone, Serialize)]
pub struct StepRun {
    pub name: String,
    pub method: String,
    pub url: String,
    pub status: Option<u16>,
    pub status_text: String,
    pub body: String,
    pub body_truncated: bool,
    pub duration_ms: u128,
    /// True iff we got an HTTP response (any status). Mirrors http_fetch.
    pub ok: bool,
    pub timed_out: bool,
    /// Substrate-level error message when `ok=false`. Empty otherwise.
    pub error: String,
    /// Names of variables this step contributed to the flow's var map.
    pub extracted: Vec<String>,
    /// Per-assertion outcome. Empty when the step declared no assertions.
    pub assertions: Vec<AssertionResult>,
}

/// Outcome of one assertion against a step's response.
#[derive(Debug, Clone, Serialize)]
pub struct AssertionResult {
    /// Pretty-printed assertion (e.g. "status == 200", "json user.id == 42").
    pub assertion: String,
    pub passed: bool,
    /// Why the assertion failed when `passed=false`. Empty otherwise.
    pub detail: String,
}

/// Outcome of running one flow.
#[derive(Debug, Clone, Serialize)]
pub struct FlowRun {
    pub flow_name: String,
    pub steps: Vec<StepRun>,
    /// True iff every step produced a response AND every assertion passed.
    pub passed: bool,
    pub duration_ms: u128,
    /// True iff the flow was aborted because of a timed-out or
    /// transport-failed step. `passed` is also false in this case.
    pub aborted: bool,
}

// ---------------------------------------------------------------------------
// Templating
// ---------------------------------------------------------------------------

/// Render `{{name}}` placeholders in `template` against `vars`. Unknown
/// variables become an empty string and are reported via the returned
/// `Vec<String>` of missing names so the caller can surface them.
pub fn render_template(template: &str, vars: &HashMap<String, String>) -> (String, Vec<String>) {
    let mut out = String::with_capacity(template.len());
    let mut missing = Vec::new();
    let bytes = template.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'{' && bytes[i + 1] == b'{' {
            // Look for closing }}.
            if let Some(rel_end) = template[i + 2..].find("}}") {
                let abs_end = i + 2 + rel_end;
                let name = template[i + 2..abs_end].trim();
                if !name.is_empty() {
                    if let Some(v) = vars.get(name) {
                        out.push_str(v);
                    } else {
                        missing.push(name.to_string());
                    }
                    i = abs_end + 2;
                    continue;
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    (out, missing)
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/// Pull a string value out of a step's response per `extract`. Returns
/// None when the path / header isn't present.
pub fn extract_value(
    extract: &Extract,
    body: &str,
    body_json: &Option<Value>,
    headers: &[(String, String)],
) -> Option<String> {
    match &extract.from {
        ExtractFrom::Json { path } => {
            let value = json_path_lookup(body_json.as_ref()?, path)?;
            // Stringify primitives directly; serialize objects/arrays.
            Some(match value {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => b.to_string(),
                Value::Null => String::new(),
                other => serde_json::to_string(other).unwrap_or_default(),
            })
        }
        ExtractFrom::Header { name } => {
            let lower = name.to_ascii_lowercase();
            for (k, v) in headers {
                if k.to_ascii_lowercase() == lower {
                    return Some(v.clone());
                }
            }
            // Unused: _body kept signature-symmetric for future text/regex extraction.
            let _ = body;
            None
        }
    }
}

/// Walk a dot-segmented JSON path. Numeric segments index arrays.
pub fn json_path_lookup<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    let path = path.trim();
    if path.is_empty() {
        return Some(root);
    }
    let mut cur = root;
    for seg in path.split('.') {
        let seg = seg.trim();
        if seg.is_empty() {
            return None;
        }
        if let Ok(idx) = seg.parse::<usize>() {
            cur = cur.get(idx)?;
        } else {
            cur = cur.get(seg)?;
        }
    }
    Some(cur)
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/// Evaluate `assertion` against a step's response. Always returns an
/// `AssertionResult`; `passed=false` includes a precise `detail` so the
/// model can report it verbatim.
pub fn check_assertion(
    assertion: &Assertion,
    status: Option<u16>,
    body: &str,
    body_json: &Option<Value>,
) -> AssertionResult {
    match assertion {
        Assertion::Status { equals } => check_status(equals, status),
        Assertion::BodyContains { value } => {
            let passed = body.contains(value.as_str());
            AssertionResult {
                assertion: format!("body contains \"{}\"", truncate_for_log(value, 60)),
                passed,
                detail: if passed {
                    String::new()
                } else {
                    format!("body does not contain \"{}\"", truncate_for_log(value, 60))
                },
            }
        }
        Assertion::JsonEq { path, value } => {
            let pretty = format!(
                "json {} == {}",
                path,
                serde_json::to_string(value).unwrap_or_else(|_| "?".into()),
            );
            let actual = body_json
                .as_ref()
                .and_then(|j| json_path_lookup(j, path));
            match actual {
                Some(actual) if actual == value => AssertionResult {
                    assertion: pretty,
                    passed: true,
                    detail: String::new(),
                },
                Some(actual) => AssertionResult {
                    assertion: pretty,
                    passed: false,
                    detail: format!(
                        "actual: {}",
                        serde_json::to_string(actual).unwrap_or_else(|_| "?".into()),
                    ),
                },
                None => AssertionResult {
                    assertion: pretty,
                    passed: false,
                    detail: format!("path '{}' not present in response body", path),
                },
            }
        }
    }
}

fn check_status(spec: &str, status: Option<u16>) -> AssertionResult {
    let pretty = format!("status == {}", spec);
    let Some(actual) = status else {
        return AssertionResult {
            assertion: pretty,
            passed: false,
            detail: "no response status (transport failure)".into(),
        };
    };
    let normalized = spec.trim().to_ascii_lowercase();
    let passed = if let Ok(exact) = normalized.parse::<u16>() {
        actual == exact
    } else if let Some(class_digit) = normalized.strip_suffix("xx") {
        match class_digit.parse::<u16>() {
            Ok(d) if (1..=5).contains(&d) => actual / 100 == d,
            _ => false,
        }
    } else {
        false
    };
    AssertionResult {
        assertion: pretty,
        passed,
        detail: if passed {
            String::new()
        } else {
            format!("actual: {}", actual)
        },
    }
}

fn truncate_for_log(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push('\u{2026}');
        out
    }
}

// ---------------------------------------------------------------------------
// Flow runner
// ---------------------------------------------------------------------------

/// Run a flow against the user's dev server. `initial_vars` seeds the
/// variable map (e.g. with the resolved dev-server base URL) so steps
/// can use `{{base_url}}/api/login`-style templates.
///
/// Returns a `FlowRun` describing every step's outcome. `passed=true`
/// iff every step got a response AND every assertion across every step
/// passed. Substrate failures (timeouts, transport errors) propagate
/// as `aborted=true` and stop the flow at the failing step.
pub async fn run_flow(
    flow_name: &str,
    steps: &[FlowStep],
    initial_vars: HashMap<String, String>,
    overall_timeout: Option<Duration>,
) -> Result<FlowRun, String> {
    if steps.is_empty() {
        return Err("flow has no steps".into());
    }
    if steps.len() > MAX_STEPS {
        return Err(format!(
            "flow has {} steps; cap is {} (split the flow or raise MAX_STEPS)",
            steps.len(),
            MAX_STEPS,
        ));
    }
    let started = Instant::now();
    let deadline = overall_timeout.map(|t| started + t);
    let mut vars = initial_vars;
    let mut step_runs: Vec<StepRun> = Vec::with_capacity(steps.len());
    let mut aborted = false;
    let mut all_passed = true;

    for (i, step) in steps.iter().enumerate() {
        if let Some(d) = deadline {
            if Instant::now() >= d {
                aborted = true;
                all_passed = false;
                break;
            }
        }
        let step_run = run_step(i, step, &mut vars).await;
        if !step_run.ok {
            aborted = true;
            all_passed = false;
            step_runs.push(step_run);
            break;
        }
        if step_run
            .assertions
            .iter()
            .any(|a| !a.passed)
        {
            all_passed = false;
        }
        step_runs.push(step_run);
    }

    Ok(FlowRun {
        flow_name: flow_name.to_string(),
        steps: step_runs,
        passed: all_passed,
        duration_ms: started.elapsed().as_millis(),
        aborted,
    })
}

async fn run_step(
    index: usize,
    step: &FlowStep,
    vars: &mut HashMap<String, String>,
) -> StepRun {
    let display_name = step
        .name
        .clone()
        .unwrap_or_else(|| format!("step {}", index + 1));

    let (url, missing_url) = render_template(&step.url, vars);
    let mut all_missing: Vec<String> = missing_url;

    let method = step
        .method
        .clone()
        .unwrap_or_else(|| "GET".into())
        .to_uppercase();

    // Render headers.
    let mut rendered_headers: Vec<(String, String)> = Vec::with_capacity(step.headers.len());
    for (k, v) in &step.headers {
        let (rk, mk) = render_template(k, vars);
        let (rv, mv) = render_template(v, vars);
        all_missing.extend(mk);
        all_missing.extend(mv);
        rendered_headers.push((rk, rv));
    }

    // Render body.
    let body = step.body.as_ref().map(|b| {
        let (rb, mb) = render_template(b, vars);
        all_missing.extend(mb);
        rb
    });

    // Surface missing-variable templates as a clean substrate failure
    // so the agent can fix the flow and re-run rather than getting a
    // confusing 4xx.
    if !all_missing.is_empty() {
        let missing = all_missing
            .iter()
            .collect::<std::collections::BTreeSet<_>>();
        return StepRun {
            name: display_name,
            method,
            url,
            status: None,
            status_text: String::new(),
            body: String::new(),
            body_truncated: false,
            duration_ms: 0,
            ok: false,
            timed_out: false,
            error: format!(
                "missing template variable(s): {}",
                missing.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "),
            ),
            extracted: Vec::new(),
            assertions: Vec::new(),
        };
    }

    let timeout = Duration::from_secs(
        step.timeout_secs.unwrap_or(STEP_DEFAULT_TIMEOUT_SECS),
    );

    let started = Instant::now();
    let client = match reqwest::Client::builder().timeout(timeout).build() {
        Ok(c) => c,
        Err(e) => {
            return StepRun {
                name: display_name,
                method,
                url,
                status: None,
                status_text: String::new(),
                body: String::new(),
                body_truncated: false,
                duration_ms: started.elapsed().as_millis(),
                ok: false,
                timed_out: false,
                error: format!("http client: {}", e),
                extracted: Vec::new(),
                assertions: Vec::new(),
            };
        }
    };
    let mut req = match method.as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "PATCH" => client.patch(&url),
        "DELETE" => client.delete(&url),
        "HEAD" => client.head(&url),
        other => {
            return StepRun {
                name: display_name,
                method: method.clone(),
                url,
                status: None,
                status_text: String::new(),
                body: String::new(),
                body_truncated: false,
                duration_ms: started.elapsed().as_millis(),
                ok: false,
                timed_out: false,
                error: format!(
                    "unsupported HTTP method '{}' (allowed: GET, POST, PUT, PATCH, DELETE, HEAD)",
                    other
                ),
                extracted: Vec::new(),
                assertions: Vec::new(),
            };
        }
    };
    for (k, v) in &rendered_headers {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let timed_out = e.is_timeout();
            return StepRun {
                name: display_name,
                method,
                url,
                status: None,
                status_text: String::new(),
                body: String::new(),
                body_truncated: false,
                duration_ms: started.elapsed().as_millis(),
                ok: false,
                timed_out,
                error: format!("transport error: {}", e),
                extracted: Vec::new(),
                assertions: Vec::new(),
            };
        }
    };

    let status = resp.status();
    let resp_headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| (
            k.to_string(),
            v.to_str().unwrap_or("<non-utf8>").to_string(),
        ))
        .collect();

    let body_bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            return StepRun {
                name: display_name,
                method,
                url,
                status: Some(status.as_u16()),
                status_text: status.canonical_reason().unwrap_or("").to_string(),
                body: String::new(),
                body_truncated: false,
                duration_ms: started.elapsed().as_millis(),
                ok: false,
                timed_out: false,
                error: format!("failed to read body: {}", e),
                extracted: Vec::new(),
                assertions: Vec::new(),
            };
        }
    };
    let mut body_str = String::from_utf8_lossy(&body_bytes).into_owned();
    let body_truncated = body_str.len() > STEP_MAX_BODY_BYTES;
    if body_truncated {
        body_str.truncate(STEP_MAX_BODY_BYTES);
        body_str.push_str("\n[\u{2026} body truncated]");
    }

    // Try to parse the body as JSON for path-based extracts/asserts.
    // The unparsed body is preserved separately so contains-asserts work.
    let body_json: Option<Value> = serde_json::from_str(body_str.trim()).ok();

    // Apply extracts.
    let mut extracted_names = Vec::new();
    for ex in &step.extract {
        if let Some(v) = extract_value(ex, &body_str, &body_json, &resp_headers) {
            vars.insert(ex.name.clone(), v);
            extracted_names.push(ex.name.clone());
        }
    }

    // Run assertions.
    let assertions: Vec<AssertionResult> = step
        .assert
        .iter()
        .map(|a| check_assertion(a, Some(status.as_u16()), &body_str, &body_json))
        .collect();

    StepRun {
        name: display_name,
        method,
        url,
        status: Some(status.as_u16()),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        body: body_str,
        body_truncated,
        duration_ms: started.elapsed().as_millis(),
        ok: true,
        timed_out: false,
        error: String::new(),
        extracted: extracted_names,
        assertions,
    }
}

// ---------------------------------------------------------------------------
// Payload renderer
// ---------------------------------------------------------------------------

/// Serialize a `FlowRun` into the JSON payload sent back to the LLM.
/// Includes a per-flow `evidence_detail` line the model can paste
/// verbatim into a Finding's `evidence: source=runtime; detail=...`
/// stanza.
pub fn to_e2e_payload(run: &FlowRun) -> Value {
    let mut total_assertions = 0;
    let mut failed_assertions = 0;
    for s in &run.steps {
        for a in &s.assertions {
            total_assertions += 1;
            if !a.passed {
                failed_assertions += 1;
            }
        }
    }
    let evidence_detail = format!(
        "runtime e2e: flow '{}' \u{2192} {} ({}/{} assertion{}{}{})",
        run.flow_name,
        if run.passed { "PASS" } else { "FAIL" },
        total_assertions - failed_assertions,
        total_assertions,
        if total_assertions == 1 { "" } else { "s" },
        if run.aborted { ", aborted" } else { "" },
        format!(", {} ms", run.duration_ms),
    );
    json!({
        "flow_name": run.flow_name,
        "passed": run.passed,
        "aborted": run.aborted,
        "duration_ms": run.duration_ms,
        "steps": run.steps.iter().map(|s| json!({
            "name": s.name,
            "method": s.method,
            "url": s.url,
            "status": s.status,
            "status_text": s.status_text,
            "body": s.body,
            "body_truncated": s.body_truncated,
            "duration_ms": s.duration_ms,
            "ok": s.ok,
            "timed_out": s.timed_out,
            "error": s.error,
            "extracted": s.extracted,
            "assertions": s.assertions.iter().map(|a| json!({
                "assertion": a.assertion,
                "passed": a.passed,
                "detail": a.detail,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "evidence_detail": evidence_detail,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    // -- Templating ----------------------------------------------------------

    #[test]
    fn render_template_substitutes_known_vars() {
        let mut v = HashMap::new();
        v.insert("base".into(), "http://localhost:5173".into());
        v.insert("token".into(), "abc123".into());
        let (s, missing) =
            render_template("{{base}}/api/me?t={{token}}", &v);
        assert_eq!(s, "http://localhost:5173/api/me?t=abc123");
        assert!(missing.is_empty());
    }

    #[test]
    fn render_template_reports_missing_vars() {
        let v = HashMap::new();
        let (s, missing) = render_template("{{a}}/{{b}}", &v);
        // Missing vars render as empty string, not the placeholder.
        assert_eq!(s, "/");
        assert_eq!(missing, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn render_template_ignores_unclosed_braces() {
        let v = HashMap::new();
        let (s, missing) = render_template("{{ no close brace", &v);
        assert_eq!(s, "{{ no close brace");
        assert!(missing.is_empty());
    }

    #[test]
    fn render_template_handles_whitespace_in_var_names() {
        let mut v = HashMap::new();
        v.insert("token".into(), "abc".into());
        let (s, _) = render_template("Bearer {{ token }}", &v);
        assert_eq!(s, "Bearer abc");
    }

    // -- Extraction ----------------------------------------------------------

    #[test]
    fn extract_json_path_returns_string_value() {
        let body = r#"{"user":{"id":42,"email":"alice@example.com"}}"#;
        let body_json: Value = serde_json::from_str(body).unwrap();
        let ex = Extract {
            name: "email".into(),
            from: ExtractFrom::Json {
                path: "user.email".into(),
            },
        };
        let got = extract_value(&ex, body, &Some(body_json), &[]);
        assert_eq!(got, Some("alice@example.com".to_string()));
    }

    #[test]
    fn extract_json_path_indexes_arrays_numerically() {
        let body = r#"{"tokens":[{"value":"first"},{"value":"second"}]}"#;
        let body_json: Value = serde_json::from_str(body).unwrap();
        let ex = Extract {
            name: "second".into(),
            from: ExtractFrom::Json {
                path: "tokens.1.value".into(),
            },
        };
        let got = extract_value(&ex, body, &Some(body_json), &[]);
        assert_eq!(got, Some("second".to_string()));
    }

    #[test]
    fn extract_json_returns_none_for_missing_path() {
        let body_json: Value = serde_json::from_str("{}").unwrap();
        let ex = Extract {
            name: "x".into(),
            from: ExtractFrom::Json {
                path: "missing.path".into(),
            },
        };
        assert_eq!(extract_value(&ex, "{}", &Some(body_json), &[]), None);
    }

    #[test]
    fn extract_header_is_case_insensitive() {
        let headers = vec![
            ("Set-Cookie".to_string(), "session=abc; HttpOnly".to_string()),
            ("Content-Type".to_string(), "text/plain".to_string()),
        ];
        let ex = Extract {
            name: "cookie".into(),
            from: ExtractFrom::Header {
                name: "set-cookie".into(),
            },
        };
        let got = extract_value(&ex, "", &None, &headers);
        assert_eq!(got, Some("session=abc; HttpOnly".to_string()));
    }

    // -- Assertions ----------------------------------------------------------

    #[test]
    fn check_status_exact_match() {
        let r = check_assertion(
            &Assertion::Status { equals: "200".into() },
            Some(200),
            "",
            &None,
        );
        assert!(r.passed);
        assert_eq!(r.assertion, "status == 200");
    }

    #[test]
    fn check_status_class_match() {
        let r = check_assertion(
            &Assertion::Status { equals: "2xx".into() },
            Some(204),
            "",
            &None,
        );
        assert!(r.passed);
    }

    #[test]
    fn check_status_class_mismatch() {
        let r = check_assertion(
            &Assertion::Status { equals: "2xx".into() },
            Some(404),
            "",
            &None,
        );
        assert!(!r.passed);
        assert!(r.detail.contains("404"));
    }

    #[test]
    fn check_status_with_no_response_fails_with_transport_note() {
        let r = check_assertion(
            &Assertion::Status { equals: "200".into() },
            None,
            "",
            &None,
        );
        assert!(!r.passed);
        assert!(r.detail.contains("transport"));
    }

    #[test]
    fn check_body_contains_pass_and_fail() {
        let pass = check_assertion(
            &Assertion::BodyContains { value: "ok".into() },
            Some(200),
            "all is ok",
            &None,
        );
        assert!(pass.passed);
        let fail = check_assertion(
            &Assertion::BodyContains { value: "missing".into() },
            Some(200),
            "all is ok",
            &None,
        );
        assert!(!fail.passed);
        assert!(fail.detail.contains("does not contain"));
    }

    #[test]
    fn check_json_eq_against_path() {
        let body = r#"{"user":{"id":42}}"#;
        let body_json: Option<Value> = serde_json::from_str(body).ok();
        let pass = check_assertion(
            &Assertion::JsonEq {
                path: "user.id".into(),
                value: json!(42),
            },
            Some(200),
            body,
            &body_json,
        );
        assert!(pass.passed);
        let fail = check_assertion(
            &Assertion::JsonEq {
                path: "user.id".into(),
                value: json!(99),
            },
            Some(200),
            body,
            &body_json,
        );
        assert!(!fail.passed);
        assert!(fail.detail.contains("actual"));
    }

    #[test]
    fn check_json_eq_missing_path_fails() {
        let body_json: Option<Value> = Some(json!({}));
        let r = check_assertion(
            &Assertion::JsonEq {
                path: "user.id".into(),
                value: json!(42),
            },
            Some(200),
            "{}",
            &body_json,
        );
        assert!(!r.passed);
        assert!(r.detail.contains("not present"));
    }

    // -- Mock-server end-to-end ---------------------------------------------

    /// Spin up a tiny TCP server that handles two endpoints:
    ///   POST /api/login  -> returns { token: "abc" }
    ///   GET  /api/me     -> 200 if Authorization header is "Bearer abc",
    ///                       else 401
    /// Returns the base URL.
    fn spawn_login_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        thread::spawn(move || {
            // Each connection is handled inline. We accept up to a few
            // requests so the flow can run start to finish.
            for _ in 0..4 {
                let Ok((mut stream, _)) = listener.accept() else { return };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .ok();
                let mut buf = [0u8; 8192];
                let Ok(n) = stream.read(&mut buf) else { continue };
                let req = String::from_utf8_lossy(&buf[..n]);
                let first_line = req.lines().next().unwrap_or("");
                let response = if first_line.starts_with("POST /api/login") {
                    let body = "{\"token\":\"abc\"}";
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body,
                    )
                } else if first_line.starts_with("GET /api/me") {
                    let auth_ok = req
                        .lines()
                        .any(|l| l.to_ascii_lowercase().starts_with("authorization:")
                            && l.contains("Bearer abc"));
                    if auth_ok {
                        let body = "{\"id\":42,\"email\":\"alice@example.com\"}";
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body,
                        )
                    } else {
                        let body = "{\"error\":\"unauthorized\"}";
                        format!(
                            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body,
                        )
                    }
                } else {
                    let body = "not found";
                    format!(
                        "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body,
                    )
                };
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        format!("http://{}", addr)
    }

    #[tokio::test]
    async fn run_flow_login_then_authenticated_get_passes() {
        let base = spawn_login_server();
        let mut headers = HashMap::new();
        headers.insert("Content-Type".to_string(), "application/json".to_string());
        let mut auth_headers = HashMap::new();
        auth_headers.insert(
            "Authorization".to_string(),
            "Bearer {{token}}".to_string(),
        );
        let steps = vec![
            FlowStep {
                name: Some("login".into()),
                method: Some("POST".into()),
                url: format!("{}/api/login", base),
                headers,
                body: Some("{\"email\":\"alice@example.com\"}".into()),
                timeout_secs: Some(3),
                extract: vec![Extract {
                    name: "token".into(),
                    from: ExtractFrom::Json {
                        path: "token".into(),
                    },
                }],
                assert: vec![Assertion::Status {
                    equals: "200".into(),
                }],
            },
            FlowStep {
                name: Some("me".into()),
                method: Some("GET".into()),
                url: format!("{}/api/me", base),
                headers: auth_headers,
                body: None,
                timeout_secs: Some(3),
                extract: vec![],
                assert: vec![
                    Assertion::Status {
                        equals: "2xx".into(),
                    },
                    Assertion::JsonEq {
                        path: "id".into(),
                        value: json!(42),
                    },
                    Assertion::BodyContains {
                        value: "alice@example.com".into(),
                    },
                ],
            },
        ];

        let run = run_flow("login_flow", &steps, HashMap::new(), Some(Duration::from_secs(5)))
            .await
            .expect("flow runs");

        assert!(run.passed, "flow should pass: {:?}", run);
        assert!(!run.aborted);
        assert_eq!(run.steps.len(), 2);
        assert_eq!(run.steps[0].extracted, vec!["token".to_string()]);
        // Every assertion across both steps passed.
        for s in &run.steps {
            for a in &s.assertions {
                assert!(a.passed, "assertion should pass: {:?}", a);
            }
        }
    }

    #[tokio::test]
    async fn run_flow_aborts_on_missing_template_variable() {
        let steps = vec![FlowStep {
            name: Some("uses-missing".into()),
            method: None,
            url: "http://localhost:1/{{undefined}}".into(),
            headers: HashMap::new(),
            body: None,
            timeout_secs: Some(1),
            extract: vec![],
            assert: vec![],
        }];
        let run = run_flow("missing_var", &steps, HashMap::new(), None)
            .await
            .expect("flow runs");
        assert!(!run.passed);
        assert!(run.aborted);
        assert_eq!(run.steps.len(), 1);
        assert!(run.steps[0]
            .error
            .contains("missing template variable"));
    }

    #[tokio::test]
    async fn run_flow_rejects_empty_steps() {
        let r = run_flow("empty", &[], HashMap::new(), None).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn run_flow_rejects_too_many_steps() {
        let steps: Vec<FlowStep> = (0..(MAX_STEPS + 1))
            .map(|i| FlowStep {
                name: Some(format!("s{}", i)),
                method: None,
                url: "http://localhost:1/x".into(),
                headers: HashMap::new(),
                body: None,
                timeout_secs: Some(1),
                extract: vec![],
                assert: vec![],
            })
            .collect();
        let r = run_flow("too_many", &steps, HashMap::new(), None).await;
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("cap"));
    }

    #[test]
    fn to_e2e_payload_emits_evidence_detail() {
        let run = FlowRun {
            flow_name: "smoke".into(),
            steps: vec![StepRun {
                name: "step 1".into(),
                method: "GET".into(),
                url: "http://x/y".into(),
                status: Some(200),
                status_text: "OK".into(),
                body: "{}".into(),
                body_truncated: false,
                duration_ms: 12,
                ok: true,
                timed_out: false,
                error: String::new(),
                extracted: vec![],
                assertions: vec![AssertionResult {
                    assertion: "status == 200".into(),
                    passed: true,
                    detail: String::new(),
                }],
            }],
            passed: true,
            duration_ms: 25,
            aborted: false,
        };
        let payload = to_e2e_payload(&run);
        let evidence = payload["evidence_detail"].as_str().unwrap();
        assert!(evidence.contains("flow 'smoke'"));
        assert!(evidence.contains("PASS"));
        assert!(evidence.contains("1/1 assertion"));
        assert_eq!(payload["passed"], true);
        assert_eq!(payload["steps"][0]["assertions"][0]["passed"], true);
    }
}
