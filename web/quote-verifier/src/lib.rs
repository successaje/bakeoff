//! Intel TDX quote verification for the Bakeoff board, in the visitor's browser.
//!
//! OutLayer publishes a TDX quote for every run. This crate checks one the way Intel's own
//! verification library does, through `dcap-qvl`: the signature chain up to the Intel root
//! certificate embedded in the crate, the platform's TCB status, and the measurements and
//! `report_data` read from the quote once it has verified. The quote and Intel's collateral are
//! inputs; nothing about them is trusted, and a tampered one fails.
//!
//! The design follows OutLayer's own browser verifier (out-layer/dashboard, `wasm-verifier`,
//! Apache-2.0). Every entry point returns `{ ok: false, error }` instead of panicking, so a bad
//! input reads as a message rather than "unreachable executed".

use serde::Serialize;
use wasm_bindgen::prelude::*;

/// The measurements of the TDX virtual machine that produced a quote, as lowercase hex.
#[derive(Serialize)]
pub struct Measurements {
    pub mrtd: String,
    pub rtmr0: String,
    pub rtmr1: String,
    pub rtmr2: String,
    pub rtmr3: String,
}

#[derive(Serialize)]
pub struct Platform {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The platform id, lowercase hex: it selects which Intel collateral applies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fmspc: Option<String>,
}

#[derive(Serialize)]
pub struct Verified {
    /// True only when the signature chain and the TCB material check out.
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Intel's TCB status, verbatim. Verification also succeeds for `OutOfDate` and
    /// `ConfigurationNeeded`, so callers must show it rather than read `ok` as "fully current".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub advisory_ids: Vec<String>,
    /// Read from the verified quote, never from metadata around it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub measurements: Option<Measurements>,
    /// All 64 bytes of `report_data`, hex. OutLayer puts the task hash in the first 32.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_data: Option<String>,
}

fn to_js<T: Serialize>(value: &T) -> JsValue {
    serde_wasm_bindgen::to_value(value).unwrap_or(JsValue::NULL)
}

fn failed(error: String) -> JsValue {
    to_js(&Verified { ok: false, error: Some(error), status: None, advisory_ids: Vec::new(), measurements: None, report_data: None })
}

/// The platform a quote claims, so the caller can fetch the matching collateral. Unverified by
/// definition: it is only a lookup key, and the verification that follows is what counts.
#[wasm_bindgen]
pub fn quote_platform(quote: &[u8]) -> JsValue {
    let parsed = match dcap_qvl::quote::Quote::parse(quote) {
        Ok(parsed) => parsed,
        Err(e) => return to_js(&Platform { ok: false, error: Some(format!("the quote could not be decoded: {e:?}")), fmspc: None }),
    };
    match dcap_qvl::intel::quote_fmspc(&parsed) {
        Ok(fmspc) => to_js(&Platform { ok: true, error: None, fmspc: Some(hex::encode(fmspc)) }),
        Err(_) => to_js(&Platform { ok: false, error: Some("the quote names no platform; it is not a TDX DCAP quote".into()), fmspc: None }),
    }
}

/// Verify a quote against Intel's collateral as of `at_secs`, the moment the run was attested:
/// collateral is valid only inside its window, so a past run is judged by what was current then.
#[wasm_bindgen]
pub fn verify_quote(quote: &[u8], collateral_json: &str, at_secs: f64) -> JsValue {
    let collateral: dcap_qvl::QuoteCollateralV3 = match serde_json::from_str(collateral_json) {
        Ok(collateral) => collateral,
        Err(e) => return failed(format!("the collateral could not be read: {e}")),
    };
    if !(at_secs.is_finite() && at_secs >= 0.0) {
        return failed("the verification time is not valid".into());
    }
    match dcap_qvl::verify::verify(quote, &collateral, at_secs as u64) {
        Ok(report) => {
            let td = report.report.as_td10();
            to_js(&Verified {
                ok: true,
                error: None,
                status: Some(report.status.clone()),
                advisory_ids: report.advisory_ids.clone(),
                measurements: td.map(|td| Measurements {
                    mrtd: hex::encode(td.mr_td),
                    rtmr0: hex::encode(td.rt_mr0),
                    rtmr1: hex::encode(td.rt_mr1),
                    rtmr2: hex::encode(td.rt_mr2),
                    rtmr3: hex::encode(td.rt_mr3),
                }),
                report_data: td.map(|td| hex::encode(td.report_data)),
            })
        }
        Err(e) => failed(format!("{e:?}")),
    }
}
