//! Bark VTXOs (docs/ARK.md): asking a Bark server for one by its id ([`client`]), reading the
//! bytes it answers with ([`decode`]), and rebuilding its exit transactions to check that they
//! hash to the id asked for and carry valid signatures ([`check`]).
//!
//! Written from Bark's wire format (ark-lib 0.8.1, MIT) without depending on it. Everything a
//! Bark server sends is untrusted: a length or index that does not fit is an error value, never a
//! panic, and a VTXO that does not check out is an error, not a page.

pub mod check;
pub mod client;
pub mod decode;
mod grpc;
pub mod id;
mod keys;

pub use check::{Checked, ExitTx, Lie, SigState, check};
pub use client::{Endpoint, FetchError, MAX_REPLY, get_vtxo};
pub use decode::{DecodeError, Policy, Transition, Vtxo, decode};
pub use id::VtxoId;
