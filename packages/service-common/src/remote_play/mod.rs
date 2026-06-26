//! Pure state-machine logic for Remote Play sessions.
//!
//! This module has no DB or network dependencies: it only encodes which
//! [`RemotePlaySessionState`] transitions are legal so the broker can validate a
//! requested change before persisting it. The allowed flow is:
//!
//! ```text
//! REQUESTED -> PREPARING -> RUNNING -> ENDED
//!     |            |           |
//!     +------------+-----------+--> FAILED | CANCELLED
//! ```
//!
//! `ENDED`, `FAILED`, and `CANCELLED` are terminal: no transition leaves them.

use retrom_codegen::retrom::RemotePlaySessionState;

/// Whether `state` is terminal (no further transitions are allowed out of it).
pub fn is_terminal(state: RemotePlaySessionState) -> bool {
    matches!(
        state,
        RemotePlaySessionState::Ended
            | RemotePlaySessionState::Failed
            | RemotePlaySessionState::Cancelled
    )
}

/// Whether moving directly from `from` to `to` is a legal transition.
///
/// Legal transitions are the happy path (`REQUESTED -> PREPARING -> RUNNING ->
/// ENDED`) plus an escape from any non-terminal state to `FAILED` or
/// `CANCELLED`. Self-transitions and any move out of a terminal state are
/// rejected.
pub fn can_transition(from: RemotePlaySessionState, to: RemotePlaySessionState) -> bool {
    use RemotePlaySessionState::*;

    // Terminal states are terminal.
    if is_terminal(from) {
        return false;
    }

    match (from, to) {
        // Happy path.
        (Requested, Preparing) => true,
        (Preparing, Running) => true,
        (Running, Ended) => true,
        // Any non-terminal state may fail or be cancelled (`from` is guaranteed
        // non-terminal by the early return above).
        (_, Failed) | (_, Cancelled) => true,
        // Everything else (skips, reversals, self-transitions) is illegal.
        _ => false,
    }
}

/// Error returned when a requested transition is not allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("illegal remote play session state transition from {from:?} to {to:?}")]
pub struct InvalidTransition {
    pub from: RemotePlaySessionState,
    pub to: RemotePlaySessionState,
}

/// Validate a transition, returning the new state on success.
pub fn transition(
    from: RemotePlaySessionState,
    to: RemotePlaySessionState,
) -> Result<RemotePlaySessionState, InvalidTransition> {
    if can_transition(from, to) {
        Ok(to)
    } else {
        Err(InvalidTransition { from, to })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use RemotePlaySessionState::*;

    const NON_TERMINAL: [RemotePlaySessionState; 3] = [Requested, Preparing, Running];
    const TERMINAL: [RemotePlaySessionState; 3] = [Ended, Failed, Cancelled];

    #[test]
    fn happy_path_transitions_are_legal() {
        assert!(can_transition(Requested, Preparing));
        assert!(can_transition(Preparing, Running));
        assert!(can_transition(Running, Ended));
    }

    #[test]
    fn any_non_terminal_may_fail_or_cancel() {
        for &from in &NON_TERMINAL {
            assert!(can_transition(from, Failed), "{from:?} -> Failed");
            assert!(can_transition(from, Cancelled), "{from:?} -> Cancelled");
        }
    }

    #[test]
    fn terminal_states_are_terminal() {
        for &from in &TERMINAL {
            assert!(is_terminal(from), "{from:?} should be terminal");
            for &to in &[Requested, Preparing, Running, Ended, Failed, Cancelled] {
                assert!(
                    !can_transition(from, to),
                    "terminal {from:?} -> {to:?} must be illegal"
                );
            }
        }
    }

    #[test]
    fn self_transitions_are_illegal() {
        for &state in &[Requested, Preparing, Running, Ended, Failed, Cancelled] {
            assert!(
                !can_transition(state, state),
                "{state:?} -> {state:?} must be illegal"
            );
        }
    }

    #[test]
    fn skips_and_reversals_are_illegal() {
        // Skipping a step on the happy path.
        assert!(!can_transition(Requested, Running));
        assert!(!can_transition(Requested, Ended));
        assert!(!can_transition(Preparing, Ended));
        // Reversals.
        assert!(!can_transition(Preparing, Requested));
        assert!(!can_transition(Running, Preparing));
        assert!(!can_transition(Running, Requested));
    }

    #[test]
    fn transition_returns_ok_for_legal_and_err_for_illegal() {
        assert_eq!(transition(Requested, Preparing), Ok(Preparing));
        assert_eq!(transition(Running, Failed), Ok(Failed));

        assert_eq!(
            transition(Requested, Running),
            Err(InvalidTransition {
                from: Requested,
                to: Running
            })
        );
        assert_eq!(
            transition(Ended, Failed),
            Err(InvalidTransition {
                from: Ended,
                to: Failed
            })
        );
    }
}
