// A sale's life (SRS v1.7, section 3). A sale is a completed fiscal invoice only once it is FISCALIZED.
//
//   DRAFT ──► AWAITING_FISCALIZATION ──► FISCALIZED        (only on PRA's Code "100")
//     │              │   ▲                  │
//     │              │   └── REJECTED ◄─────┤ (PRA answered with an error: correct and send again, or cancel)
//     ▼              ├──► OUTCOME_UNKNOWN     └─ a credit note is a new sale that points at this one
//  CANCELLED ◄───────┘      (no answer: never retried by itself; resolved by hand after checking PRA's report)
//
// An AWAITING sale can also be cancelled: SRS 5.3 allows cancelling anything not yet fiscalized, and a sale that is still
// AWAITING was either never sent or was refused before PRA saw it (no connection).
const STATES = ['DRAFT', 'AWAITING_FISCALIZATION', 'OUTCOME_UNKNOWN', 'FISCALIZED', 'REJECTED', 'CANCELLED'];

const NEXT = {
    DRAFT: ['AWAITING_FISCALIZATION', 'CANCELLED'],
    AWAITING_FISCALIZATION: ['FISCALIZED', 'OUTCOME_UNKNOWN', 'REJECTED', 'CANCELLED'],
    OUTCOME_UNKNOWN: ['FISCALIZED', 'REJECTED', 'OUTCOME_UNKNOWN'], // FISCALIZED only after a confirmed manual check
    REJECTED: ['AWAITING_FISCALIZATION', 'CANCELLED'],
    FISCALIZED: [],
    CANCELLED: [],
};

const canMove = (from, to) => Boolean(NEXT[from] && NEXT[from].includes(to));

class PosStateError extends Error {}
function assertMove(from, to) {
    if (!canMove(from, to)) throw new PosStateError(`A sale that is ${from.toLowerCase().replace(/_/g, ' ')} cannot become ${to.toLowerCase().replace(/_/g, ' ')}.`);
}

module.exports = { STATES, NEXT, canMove, assertMove, PosStateError };
