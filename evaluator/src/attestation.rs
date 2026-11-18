//! Checks that a run's answers came from NEAR AI Cloud's attested TEEs.
//!
//! When a challenge's rules ask for it (`"model_attestation": "near-ai-cloud"`), the evaluator
//! does what NEAR AI's own verifier (nearai/nearai-cloud-verifier) does, from inside the
//! OutLayer enclave, for every answer it scores:
//!
//! 1. **Each answer is signed.** NEAR AI signs `model:sha256(request):sha256(response)` for every
//!    chat completion with a key held in its TEE. The evaluator hashes the exact bytes it sent
//!    and received, compares them with the signed text, and recovers the signer from the
//!    Ethereum-style (EIP-191) signature.
//! 2. **Each signing key is attested.** For every signer, the evaluator fetches NEAR AI's
//!    attestation report with a fresh nonce made inside the enclave. Each server's Intel TDX
//!    quote is verified with `dcap-qvl` against Intel's collateral, and its `report_data` must
//!    hold the signing address and that nonce, so the report is current and the key lives in
//!    that TEE. The quote's `mr_config_id` must commit to the server's published container
//!    setup, and the GPU evidence must carry the same nonce and pass NVIDIA's attestation
//!    service.
//!
//! The network calls live in the WASI transport (`main.rs`); everything here is pure, so it is
//! tested natively with a real report, quote and signature recorded from NEAR AI Cloud.

use dcap_qvl::QuoteCollateralV3;
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use sha3::Keccak256;

/// Intel's Provisioning Certification Service, where TDX collateral is published.
pub const INTEL_PCS: &str = "https://api.trustedservices.intel.com";
/// The CRL of Intel's SGX root CA, as its certificate's CRL distribution point names it.
pub const INTEL_ROOT_CA_CRL: &str =
    "https://certificates.trustedservices.intel.com/IntelSGXRootCA.der";
/// NVIDIA's Remote Attestation Service for GPUs, as NEAR AI's verifier calls it.
pub const NVIDIA_NRAS: &str = "https://nras.attestation.nvidia.com/v3/attest/gpu";

/// What the verdict says about the TEEs that answered. Kept small: the verdict's whole budget is
/// under a kilobyte.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelTee {
    /// Answers whose signature checked out against an attested key.
    pub signed: u32,
    /// Answers the run scored.
    pub answers: u32,
    /// The attested signing addresses, `0x` and 40 hex digits.
    pub signers: Vec<String>,
    /// Intel's TCB status for the TDX quotes, the least current one if they differ.
    pub tdx: String,
    /// Every attested server's GPU evidence carried the nonce and passed NVIDIA's service.
    pub gpu: bool,
}

/// One scored answer: what the provider must have signed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    pub model: String,
    pub chat_id: String,
    pub request_sha256: String,
    pub response_sha256: String,
}

impl Receipt {
    /// The receipt for a completed call, from the exact bytes sent and received. None when the
    /// response names no completion id, so it cannot be looked up.
    pub fn new(model: &str, request_body: &[u8], response_body: &[u8]) -> Option<Self> {
        #[derive(Deserialize)]
        struct Id {
            id: String,
        }
        let id: Id = serde_json::from_slice(response_body).ok()?;
        Some(Self {
            model: model.to_string(),
            chat_id: id.id,
            request_sha256: sha256_hex(request_body),
            response_sha256: sha256_hex(response_body),
        })
    }
}

/// `GET /v1/signature/{chat_id}`.
#[derive(Debug, Deserialize)]
pub struct SignedAnswer {
    pub text: String,
    pub signature: String,
    pub signing_address: String,
    #[serde(default)]
    pub signing_algo: Option<String>,
}

/// Checks one answer's signature and returns the signing address it recovers to.
pub fn check_signature(receipt: &Receipt, signed: &SignedAnswer) -> Result<[u8; 20], String> {
    if let Some(algo) = &signed.signing_algo {
        if !algo.eq_ignore_ascii_case("ecdsa") {
            return Err(format!("signed with {algo}, not ecdsa"));
        }
    }
    // "model:request:response", or "request:response" from older servers. A model name may hold
    // colons, so the hashes are read from the right.
    let mut parts = signed.text.rsplitn(3, ':');
    let response = parts.next().unwrap_or_default();
    let request = parts.next().ok_or("the signed text names no request")?;
    if let Some(model) = parts.next() {
        if model != receipt.model {
            return Err(format!("signed for model {model}, not {}", receipt.model));
        }
    }
    if !request.eq_ignore_ascii_case(&receipt.request_sha256) {
        return Err("the signed request hash is not the request sent".into());
    }
    if !response.eq_ignore_ascii_case(&receipt.response_sha256) {
        return Err("the signed response hash is not the response received".into());
    }
    let recovered = recover_eip191(&signed.text, &signed.signature)?;
    if recovered != parse_address(&signed.signing_address)? {
        return Err("the signature does not recover to the named signer".into());
    }
    Ok(recovered)
}

/// The Ethereum address that signed `message` with `personal_sign` (EIP-191).
pub fn recover_eip191(message: &str, signature_hex: &str) -> Result<[u8; 20], String> {
    let bytes = hex::decode(signature_hex.trim_start_matches("0x"))
        .map_err(|_| "the signature is not hex")?;
    if bytes.len() != 65 {
        return Err(format!("the signature is {} bytes, not 65", bytes.len()));
    }
    let signature =
        Signature::from_slice(&bytes[..64]).map_err(|_| "the signature is malformed")?;
    let v = bytes[64];
    let id = RecoveryId::from_byte(if v >= 27 { v - 27 } else { v })
        .ok_or("the signature's recovery id is invalid")?;
    let mut hasher = Keccak256::new();
    hasher.update(format!("\x19Ethereum Signed Message:\n{}", message.len()).as_bytes());
    hasher.update(message.as_bytes());
    let digest = hasher.finalize();
    let key = VerifyingKey::recover_from_prehash(&digest, &signature, id)
        .map_err(|_| "no key recovers from the signature")?;
    Ok(address_of(&key))
}

fn address_of(key: &VerifyingKey) -> [u8; 20] {
    let point = key.to_encoded_point(false);
    let hash = Keccak256::digest(&point.as_bytes()[1..]);
    let mut address = [0u8; 20];
    address.copy_from_slice(&hash[12..]);
    address
}

pub fn parse_address(text: &str) -> Result<[u8; 20], String> {
    let bytes = hex::decode(text.trim_start_matches("0x"))
        .map_err(|_| format!("{text} is not an address"))?;
    bytes
        .try_into()
        .map_err(|_| format!("{text} is not a 20-byte address"))
}

pub fn address_hex(address: &[u8; 20]) -> String {
    format!("0x{}", hex::encode(address))
}

/// The nonce for this run's attestation reports: fresh, from `random`, and tied to the
/// evaluation by `binding`, the hash of its rules, candidate and test set.
pub fn nonce(binding: &[u8; 32], random: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"bakeoff/model-attestation/v1");
    hasher.update(binding);
    hasher.update(random);
    hasher.finalize().into()
}

/// `GET /v1/attestation/report`: the parts the evaluator checks. The report is large (about
/// 800 KB, most of it GPU evidence); everything else in it is skipped.
#[derive(Debug, Deserialize)]
pub struct Report {
    #[serde(default)]
    pub model_attestations: Vec<ServerAttestation>,
}

#[derive(Debug, Deserialize)]
pub struct ServerAttestation {
    pub signing_address: String,
    /// The TDX quote, hex.
    pub intel_quote: String,
    /// NVIDIA's evidence for the server's GPUs, a JSON document in a string.
    pub nvidia_payload: String,
    #[serde(default)]
    pub info: Option<ServerInfo>,
}

#[derive(Debug, Deserialize)]
pub struct ServerInfo {
    /// dstack's TCB info, sometimes as a JSON string; it holds `app_compose`.
    #[serde(default)]
    pub tcb_info: Option<serde_json::Value>,
}

impl ServerAttestation {
    pub fn quote(&self) -> Result<Vec<u8>, String> {
        hex::decode(self.intel_quote.trim_start_matches("0x"))
            .map_err(|_| "the TDX quote is not hex".into())
    }

    /// The container setup the server published, which its quote's `mr_config_id` commits to.
    pub fn app_compose(&self) -> Option<String> {
        let tcb = self.info.as_ref()?.tcb_info.as_ref()?;
        let tcb = match tcb {
            serde_json::Value::String(text) => serde_json::from_str(text).ok()?,
            other => other.clone(),
        };
        tcb.get("app_compose")?.as_str().map(str::to_owned)
    }
}

/// The servers in a report that hold `signer`'s key.
pub fn servers_for<'a>(report: &'a Report, signer: &[u8; 20]) -> Vec<&'a ServerAttestation> {
    report
        .model_attestations
        .iter()
        .filter(|server| {
            parse_address(&server.signing_address).is_ok_and(|address| &address == signer)
        })
        .collect()
}

/// Verifies a server's TDX quote as of `now_secs` and checks what it binds: the signing
/// address and the nonce in `report_data`, and the container setup in `mr_config_id`. Returns
/// Intel's TCB status.
pub fn check_quote(
    quote: &[u8],
    collateral: &QuoteCollateralV3,
    now_secs: u64,
    signer: &[u8; 20],
    nonce: &[u8; 32],
    app_compose: Option<&str>,
) -> Result<String, String> {
    let verified = dcap_qvl::verify::verify(quote, collateral, now_secs)
        .map_err(|e| format!("the TDX quote does not verify: {e:#}"))?;
    let td = verified
        .report
        .as_td10()
        .ok_or("the quote is not from a TDX virtual machine")?;
    let mut expected = [0u8; 64];
    expected[..20].copy_from_slice(signer);
    expected[32..].copy_from_slice(nonce);
    if td.report_data[..32] != expected[..32] {
        return Err("the quote's report data does not name the signing address".into());
    }
    if td.report_data[32..] != expected[32..] {
        return Err("the quote's report data does not hold this run's nonce".into());
    }
    let compose = app_compose.ok_or("the server published no container setup")?;
    let compose_hash = Sha256::digest(compose.as_bytes());
    if td.mr_config_id[0] != 1 || td.mr_config_id[1..33] != compose_hash[..] {
        return Err("the quote does not commit to the server's published container setup".into());
    }
    Ok(verified.status.clone())
}

/// The GPU evidence must answer this run's nonce.
pub fn check_gpu_nonce(nvidia_payload: &str, nonce: &[u8; 32]) -> Result<(), String> {
    #[derive(Deserialize)]
    struct Payload {
        nonce: String,
    }
    let payload: Payload =
        serde_json::from_str(nvidia_payload).map_err(|_| "the GPU evidence is malformed")?;
    if payload.nonce.eq_ignore_ascii_case(&hex::encode(nonce)) {
        Ok(())
    } else {
        Err("the GPU evidence does not answer this run's nonce".into())
    }
}

/// NVIDIA's overall verdict, from its service's reply: `[["JWT", token], …]`. Like NEAR AI's
/// verifier, this reads the claim from the token the service returned over TLS; the token's own
/// signature is not checked.
pub fn nras_verdict(body: &[u8]) -> Result<bool, String> {
    let reply: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| "NVIDIA's reply is not JSON")?;
    let token = reply
        .get(0)
        .and_then(|entry| entry.get(1))
        .and_then(|t| t.as_str())
        .ok_or("NVIDIA's reply holds no token")?;
    let payload = token
        .split('.')
        .nth(1)
        .ok_or("NVIDIA's token is malformed")?;
    let claims: serde_json::Value = serde_json::from_slice(&base64url(payload)?)
        .map_err(|_| "NVIDIA's token claims are not JSON")?;
    claims
        .get("x-nvidia-overall-att-result")
        .and_then(|v| v.as_bool())
        .ok_or_else(|| "NVIDIA's token gives no overall result".into())
}

fn base64url(text: &str) -> Result<Vec<u8>, String> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut buffer, mut bits) = (0u32, 0u32);
    for byte in text.trim_end_matches('=').bytes() {
        let value = ALPHABET
            .iter()
            .position(|&c| c == byte)
            .ok_or("not base64url")? as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Ok(out)
}

/// The URLs Intel's collateral for `quote` is fetched from, in the order `collateral_from`
/// takes the responses: PCK CRL, TCB info, QE identity, root CA CRL. Ported from dcap-qvl's
/// `CollateralClient` (MIT), whose own client needs reqwest, which has no WASI build.
pub fn collateral_urls(quote: &[u8]) -> Result<[String; 4], String> {
    let parsed = dcap_qvl::quote::Quote::parse(quote)
        .map_err(|e| format!("the quote could not be decoded: {e:#}"))?;
    let fmspc = hex::encode_upper(
        dcap_qvl::intel::quote_fmspc(&parsed)
            .map_err(|e| format!("the quote names no platform: {e:#}"))?,
    );
    let ca = dcap_qvl::intel::quote_ca(&parsed)
        .map_err(|e| format!("the quote names no PCK CA: {e:#}"))?
        .as_id_str();
    let tee = if parsed.header.is_sgx() { "sgx" } else { "tdx" };
    Ok([
        format!("{INTEL_PCS}/sgx/certification/v4/pckcrl?ca={ca}&encoding=der"),
        format!("{INTEL_PCS}/{tee}/certification/v4/tcb?fmspc={fmspc}"),
        format!("{INTEL_PCS}/{tee}/certification/v4/qe/identity?update=standard"),
        INTEL_ROOT_CA_CRL.to_string(),
    ])
}

/// A collateral response: its body and the issuer-chain header Intel sends with it.
pub struct Fetched<'a> {
    pub body: &'a [u8],
    pub header: &'a dyn Fn(&str) -> Option<String>,
}

/// Intel's collateral from the responses to `collateral_urls`, as `dcap_qvl::verify` takes it.
pub fn collateral_from(
    pck_crl: Fetched<'_>,
    tcb_info: Fetched<'_>,
    qe_identity: Fetched<'_>,
    root_ca_crl: &[u8],
) -> Result<QuoteCollateralV3, String> {
    #[derive(Deserialize)]
    struct Signed<'a> {
        #[serde(rename = "tcbInfo", alias = "enclaveIdentity", borrow)]
        body: &'a RawValue,
        signature: String,
    }
    let chain = |fetched: &Fetched<'_>, names: &[&str]| {
        names
            .iter()
            .find_map(|name| (fetched.header)(name))
            .map(|value| percent_decode(&value))
            .ok_or_else(|| format!("Intel sent no {} header", names[0]))
    };
    let signed = |body: &[u8], what: &str| -> Result<(String, Vec<u8>), String> {
        let text = std::str::from_utf8(body).map_err(|_| format!("the {what} is not UTF-8"))?;
        let signed: Signed<'_> =
            serde_json::from_str(text).map_err(|_| format!("the {what} is malformed"))?;
        let signature = hex::decode(&signed.signature)
            .map_err(|_| format!("the {what} signature is not hex"))?;
        // The exact bytes Intel signed, not a re-serialization of them.
        Ok((signed.body.get().to_string(), signature))
    };
    let (tcb_info_body, tcb_info_signature) = signed(tcb_info.body, "TCB info")?;
    let (qe_identity_body, qe_identity_signature) = signed(qe_identity.body, "QE identity")?;
    Ok(QuoteCollateralV3 {
        pck_crl_issuer_chain: chain(&pck_crl, &["SGX-PCK-CRL-Issuer-Chain"])?,
        root_ca_crl: root_ca_crl.to_vec(),
        pck_crl: pck_crl.body.to_vec(),
        tcb_info_issuer_chain: chain(
            &tcb_info,
            &["TCB-Info-Issuer-Chain", "SGX-TCB-Info-Issuer-Chain"],
        )?,
        tcb_info: tcb_info_body,
        tcb_info_signature,
        qe_identity_issuer_chain: chain(&qe_identity, &["SGX-Enclave-Identity-Issuer-Chain"])?,
        qe_identity: qe_identity_body,
        qe_identity_signature,
        pck_certificate_chain: None,
    })
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&text[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The less current of two TCB statuses, so the verdict reports the weakest quote checked.
pub fn least_current(a: &str, b: &str) -> String {
    const ORDER: [&str; 6] = [
        "UpToDate",
        "SWHardeningNeeded",
        "ConfigurationNeeded",
        "ConfigurationAndSWHardeningNeeded",
        "OutOfDate",
        "OutOfDateConfigurationNeeded",
    ];
    let rank = |s: &str| ORDER.iter().position(|o| *o == s).unwrap_or(ORDER.len());
    if rank(a) >= rank(b) { a } else { b }.to_string()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    //! Against a real NEAR AI Cloud attestation report, signed chat and Intel collateral,
    //! recorded on 2026-11-18 (`tests/fixtures/near-ai`). The report keeps one server and trims
    //! its GPU evidence to the nonce.
    use super::*;

    const REPORT: &str = include_str!("../tests/fixtures/near-ai/report.json");
    const NONCE: &str = include_str!("../tests/fixtures/near-ai/nonce.txt");
    const CHAT: &str = include_str!("../tests/fixtures/near-ai/signed-chat.json");
    const SIGNER: &str = "0x3b753b4406613c5e70ae640508632b600424fa0c";

    fn fixture_nonce() -> [u8; 32] {
        hex::decode(NONCE.trim()).unwrap().try_into().unwrap()
    }

    fn header_of(raw: &'static str) -> impl Fn(&str) -> Option<String> {
        move |name: &str| {
            raw.lines().find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.trim()
                    .eq_ignore_ascii_case(name)
                    .then(|| value.trim().to_string())
            })
        }
    }

    fn collateral() -> QuoteCollateralV3 {
        let pck = header_of(include_str!(
            "../tests/fixtures/near-ai/collateral/pck-crl.headers"
        ));
        let tcb = header_of(include_str!(
            "../tests/fixtures/near-ai/collateral/tcb-info.headers"
        ));
        let qe = header_of(include_str!(
            "../tests/fixtures/near-ai/collateral/qe-identity.headers"
        ));
        collateral_from(
            Fetched {
                body: include_bytes!("../tests/fixtures/near-ai/collateral/pck-crl.body"),
                header: &pck,
            },
            Fetched {
                body: include_bytes!("../tests/fixtures/near-ai/collateral/tcb-info.body"),
                header: &tcb,
            },
            Fetched {
                body: include_bytes!("../tests/fixtures/near-ai/collateral/qe-identity.body"),
                header: &qe,
            },
            include_bytes!("../tests/fixtures/near-ai/collateral/root-ca-crl.body"),
        )
        .unwrap()
    }

    fn recorded_at() -> u64 {
        include_str!("../tests/fixtures/near-ai/collateral/recorded-at.txt")
            .trim()
            .parse()
            .unwrap()
    }

    fn report() -> Report {
        serde_json::from_str(REPORT).unwrap()
    }

    fn chat() -> (Receipt, SignedAnswer) {
        #[derive(Deserialize)]
        struct Recorded {
            model: String,
            request: String,
            response: String,
            signature: SignedAnswer,
        }
        let recorded: Recorded = serde_json::from_str(CHAT).unwrap();
        let receipt = Receipt::new(
            &recorded.model,
            recorded.request.as_bytes(),
            recorded.response.as_bytes(),
        )
        .unwrap();
        (receipt, recorded.signature)
    }

    #[test]
    fn an_answer_signed_in_near_ais_tee_recovers_to_its_signer() {
        let (receipt, signed) = chat();
        assert_eq!(
            address_hex(&check_signature(&receipt, &signed).unwrap()),
            SIGNER
        );
    }

    #[test]
    fn a_signature_over_other_bytes_or_by_another_key_is_refused() {
        let (receipt, signed) = chat();
        let other_response = Receipt {
            response_sha256: sha256_hex(b"{}"),
            ..receipt.clone()
        };
        assert!(check_signature(&other_response, &signed)
            .unwrap_err()
            .contains("response"));
        let other_request = Receipt {
            request_sha256: sha256_hex(b"{}"),
            ..receipt.clone()
        };
        assert!(check_signature(&other_request, &signed)
            .unwrap_err()
            .contains("request"));
        let other_model = Receipt {
            model: "qwen/qwen3.5-397b-a17b".into(),
            ..receipt.clone()
        };
        assert!(check_signature(&other_model, &signed)
            .unwrap_err()
            .contains("model"));
        let claimed = SignedAnswer {
            signing_address: format!("0x{}", "11".repeat(20)),
            ..signed
        };
        assert!(check_signature(&receipt, &claimed)
            .unwrap_err()
            .contains("recover"));
        let (receipt, signed) = chat();
        let mut bytes = hex::decode(signed.signature.trim_start_matches("0x")).unwrap();
        bytes[10] ^= 1;
        let forged = SignedAnswer {
            signature: hex::encode(bytes),
            ..signed
        };
        assert!(check_signature(&receipt, &forged).is_err());
    }

    #[test]
    fn a_receipt_needs_the_completion_id() {
        assert!(Receipt::new("m", b"{}", br#"{"choices":[]}"#).is_none());
        assert_eq!(
            Receipt::new("m", b"{}", br#"{"id":"chat-1"}"#)
                .unwrap()
                .chat_id,
            "chat-1"
        );
    }

    #[test]
    fn a_genuine_quote_binds_the_signer_the_nonce_and_the_container_setup() {
        let report = report();
        let signer = parse_address(SIGNER).unwrap();
        let servers = servers_for(&report, &signer);
        assert_eq!(servers.len(), 1);
        let server = servers[0];
        let status = check_quote(
            &server.quote().unwrap(),
            &collateral(),
            recorded_at(),
            &signer,
            &fixture_nonce(),
            server.app_compose().as_deref(),
        )
        .unwrap();
        assert_eq!(status, "UpToDate");
        assert!(servers_for(&report, &[0x11; 20]).is_empty());
    }

    #[test]
    fn a_quote_for_another_nonce_signer_or_setup_is_refused() {
        let report = report();
        let server = &report.model_attestations[0];
        let quote = server.quote().unwrap();
        let signer = parse_address(SIGNER).unwrap();
        let compose = server.app_compose();
        let check = |signer: &[u8; 20], nonce: &[u8; 32], compose: Option<&str>| {
            check_quote(&quote, &collateral(), recorded_at(), signer, nonce, compose)
        };
        assert!(check(&signer, &[7; 32], compose.as_deref())
            .unwrap_err()
            .contains("nonce"));
        assert!(check(&[0x11; 20], &fixture_nonce(), compose.as_deref())
            .unwrap_err()
            .contains("signing address"));
        assert!(check(&signer, &fixture_nonce(), Some("{}"))
            .unwrap_err()
            .contains("container setup"));
        assert!(check(&signer, &fixture_nonce(), None)
            .unwrap_err()
            .contains("container setup"));

        // A quote altered anywhere in what Intel's chain signs no longer verifies.
        let mut tampered = quote.clone();
        tampered[48 + 520] ^= 1;
        assert!(check_quote(
            &tampered,
            &collateral(),
            recorded_at(),
            &signer,
            &fixture_nonce(),
            compose.as_deref()
        )
        .unwrap_err()
        .contains("does not verify"));
        // Nor does one checked after Intel's collateral for it has expired.
        assert!(check_quote(
            &quote,
            &collateral(),
            recorded_at() + 400 * 86_400,
            &signer,
            &fixture_nonce(),
            compose.as_deref()
        )
        .is_err());
    }

    #[test]
    fn the_gpu_evidence_must_answer_the_nonce() {
        let server = &report().model_attestations[0];
        check_gpu_nonce(&server.nvidia_payload, &fixture_nonce()).unwrap();
        assert!(check_gpu_nonce(&server.nvidia_payload, &[7; 32]).is_err());
        assert!(check_gpu_nonce("not json", &fixture_nonce()).is_err());
    }

    fn token(claims: &str) -> Vec<u8> {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut encoded = String::new();
        for chunk in claims.as_bytes().chunks(3) {
            let n = chunk.iter().fold(0u32, |n, b| (n << 8) | *b as u32) << (8 * (3 - chunk.len()));
            for i in 0..=chunk.len() {
                encoded.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            }
        }
        format!(r#"[["JWT","eyJhbGciOiJFUzM4NCJ9.{encoded}.c2ln"],{{"GPU-0":"…"}}]"#).into_bytes()
    }

    #[test]
    fn nvidias_overall_result_is_read_from_its_token() {
        assert_eq!(
            nras_verdict(&token(
                r#"{"x-nvidia-overall-att-result":true,"iss":"nras"}"#
            )),
            Ok(true)
        );
        assert_eq!(
            nras_verdict(&token(r#"{"x-nvidia-overall-att-result":false}"#)),
            Ok(false)
        );
        assert!(nras_verdict(&token(r#"{"iss":"nras"}"#)).is_err());
        assert!(nras_verdict(b"[]").is_err());
    }

    #[test]
    fn each_run_has_its_own_nonce_tied_to_what_it_scored() {
        let a = nonce(&[1; 32], &[2; 32]);
        assert_ne!(a, nonce(&[1; 32], &[3; 32]));
        assert_ne!(a, nonce(&[4; 32], &[2; 32]));
        assert_eq!(a, nonce(&[1; 32], &[2; 32]));
    }

    #[test]
    fn the_least_current_status_is_kept() {
        assert_eq!(least_current("UpToDate", "OutOfDate"), "OutOfDate");
        assert_eq!(
            least_current("SWHardeningNeeded", "UpToDate"),
            "SWHardeningNeeded"
        );
        assert_eq!(least_current("UpToDate", "UpToDate"), "UpToDate");
    }

    #[test]
    fn issuer_chains_arrive_percent_encoded() {
        assert_eq!(
            percent_decode("-----BEGIN%20CERTIFICATE-----%0AMII"),
            "-----BEGIN CERTIFICATE-----\nMII"
        );
    }
}
