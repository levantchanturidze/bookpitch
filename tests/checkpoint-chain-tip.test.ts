import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  verifyCheckpointChain,
  renderCheckpoint,
  renderState,
  parseState,
  soakStateDigest,
  verifySoakState,
} from '../scripts/soak-controller.mjs';

// -----------------------------------------------------------------------------
// §4 — a state body AHEAD of the checkpoint chain was accepted.
//
// The chain exists so that restoring an older issue body is detectable: comment
// ids are monotonic and are not part of the body. It checked four things —
// rollback, deletion, forking, reordering — and had a hole in the fifth:
//
//     tickSeq  <  tip   rolled back      refused
//     tickSeq ===  tip   digest compared  refused on mismatch
//     tickSeq  >  tip   ...fell through to { ok: true }
//
// The persistence order is body first, checkpoint second, and the comment at
// that call site said: "a failure between the two leaves a body without its
// checkpoint — which the next tick reads as a gap and refuses." It did not. The
// single crash the write order was designed around was the single case that
// passed silently, and the tick it certified had no external anchor at all.
//
// Reproduced below through the real persistence sequence: render a body at tick
// N, post checkpoints only up to N-1, verify.
//
// Also here: a CAPPED comment read. GitHub returns issue comments oldest first,
// so exhausting the page budget drops the NEWEST checkpoints — leaving a stale
// tip that the body legitimately sits ahead of. Every check in the verifier
// reasons about the tip, so a truncated list makes all of them wrong at once.
// -----------------------------------------------------------------------------

const SECRET = 'checkpoint-chain-secret';

/** The state the controller would write on tick `n`, signed as it signs it. */
function stateAt(
  n: number,
  over: Record<string, unknown> = {},
): {
  tickSeq: number;
  stateDigest: string;
  [k: string]: unknown;
} {
  const st: Record<string, unknown> = {
    schemaVersion: 1,
    releaseSha: 'a'.repeat(40),
    deploymentId: '6221617929',
    startedAt: '2026-09-01T00:00:00Z',
    effectiveWindowStart: '2026-09-01T00:00:00Z',
    restarts: [],
    tickSeq: n,
    lastTickAt: `2026-09-01T${String(n).padStart(2, '0')}:00:00Z`,
    ...over,
  };
  st.stateDigest = soakStateDigest(SECRET, st);
  return st as { tickSeq: number; stateDigest: string; [k: string]: unknown };
}

/** Checkpoint comments for ticks 0..n inclusive, with monotonic ids. */
function chainTo(n: number) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const st = stateAt(i);
    out.push({
      id: 1000 + i,
      body: renderCheckpoint({ tickSeq: i, stateDigest: st.stateDigest }),
    });
  }
  return out;
}

describe('the chain tip must agree with the body exactly', () => {
  it('the baseline agrees at the tip', () => {
    expect(verifyCheckpointChain(chainTo(3), stateAt(3), { complete: true }).ok).toBe(true);
  });

  it('THE DEFECT: a body one tick ahead of the chain is refused', () => {
    // Body write succeeded, checkpoint write failed, next invocation.
    const r = verifyCheckpointChain(chainTo(3), stateAt(4), { complete: true });
    expect(r.ok, 'tick 4 has no external anchor').toBe(false);
    expect(r.reason).toMatch(/tick 4/);
    expect(r.reason).toMatch(/never checkpointed/);
  });

  it('THE DEFECT: a body many ticks ahead is refused, and says how many', () => {
    const r = verifyCheckpointChain(chainTo(3), stateAt(9), { complete: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ticks 4–9/);
  });

  it('the refusal does not pretend to know which cause it was', () => {
    // A crashed tick and a deleted checkpoint produce identical evidence. The
    // message must say so rather than choose.
    const r = verifyCheckpointChain(chainTo(3), stateAt(4), { complete: true });
    expect(r.reason).toMatch(/indistinguishable/);
  });

  it('a rolled-back body is still refused', () => {
    const r = verifyCheckpointChain(chainTo(5), stateAt(2), { complete: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/rolled back/);
  });

  it('a matching tick with a mismatched digest is still refused', () => {
    const tampered = { ...stateAt(3), stateDigest: 'f'.repeat(64) };
    const r = verifyCheckpointChain(chainTo(3), tampered, { complete: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not match its own checkpoint/);
  });

  it('a deleted middle checkpoint is still refused', () => {
    const holed = chainTo(5).filter((c) => !c.body.includes('tick 3 '));
    const r = verifyCheckpointChain(holed, stateAt(5), { complete: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/gap in the checkpoint chain/);
  });
});

describe('a capped comment read is not a complete history', () => {
  it('THE DEFECT: truncation is refused, not treated as a short chain', () => {
    // Without this, exhausting the page budget looks exactly like a soak whose
    // body has legitimately moved ahead of an old tip.
    const r = verifyCheckpointChain(chainTo(3), stateAt(3), { complete: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/could not be read in full/);
  });

  it('and it says which end is missing, because that is the surprising part', () => {
    const r = verifyCheckpointChain(chainTo(3), stateAt(3), { complete: false });
    expect(r.reason).toMatch(/oldest first|MOST RECENT/);
  });

  it('truncation is refused even when the tip happens to agree', () => {
    const r = verifyCheckpointChain(chainTo(9), stateAt(9), { complete: false });
    expect(r.ok, 'agreement with an unknown tip is not agreement').toBe(false);
  });

  it('COMPLEMENT: an explicitly complete read still passes', () => {
    expect(verifyCheckpointChain(chainTo(9), stateAt(9), { complete: true }).ok).toBe(true);
  });

  it('COMPLEMENT: an omitted option is not read as truncated', () => {
    // Only an explicit `false` means truncated. An absent flag must not brick
    // every existing caller into a permanent refusal.
    expect(verifyCheckpointChain(chainTo(2), stateAt(2)).ok).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Through the persistence lifecycle, using the real render/parse/sign path
// rather than hand-built fixtures.
// -----------------------------------------------------------------------------
describe('a failure between the two writes is caught on the next tick', () => {
  /** Simulate one tick's persistence, optionally dropping the checkpoint. */
  function tick(
    prev: { comments: Array<{ id: number; body: string }>; body: string },
    n: number,
    { checkpointWriteFails = false } = {},
  ) {
    const st = stateAt(n);
    const body = renderState(st); // the PATCH that lands first
    const comments = [...prev.comments];
    if (!checkpointWriteFails) {
      comments.push({
        id: 1000 + n,
        body: renderCheckpoint({ tickSeq: n, stateDigest: st.stateDigest }),
      });
    }
    return { comments, body };
  }

  it('the body is genuine and correctly signed — and still refused', () => {
    // The point. This is not a forgery: the state is exactly what the crashed
    // tick computed, and it verifies against the secret. It is refused because
    // nothing outside the body attests to it.
    let s = { comments: [] as Array<{ id: number; body: string }>, body: '' };
    s = tick(s, 0);
    s = tick(s, 1);
    s = tick(s, 2, { checkpointWriteFails: true });

    const parsed = parseState(s.body);
    expect(parsed.tickSeq).toBe(2);
    expect(verifySoakState(SECRET, parsed).ok, 'the signature is valid').toBe(true);

    const chain = verifyCheckpointChain(s.comments, parsed, { complete: true });
    expect(chain.ok, 'a valid signature is not an external anchor').toBe(false);
    expect(chain.reason).toMatch(/tick 2/);
  });

  it('COMPLEMENT: the same sequence with both writes landing is accepted', () => {
    let s = { comments: [] as Array<{ id: number; body: string }>, body: '' };
    s = tick(s, 0);
    s = tick(s, 1);
    s = tick(s, 2);
    const parsed = parseState(s.body);
    expect(verifyCheckpointChain(s.comments, parsed, { complete: true }).ok).toBe(true);
  });

  it('the controller refuses rather than repairing the chain itself', () => {
    // Re-anchoring would mean writing the missing checkpoint from the state
    // under suspicion, which proves only what it already assumed. The source
    // must say so, and the caller must exit rather than continue.
    const src = readFileSync('scripts/soak-controller.mjs', 'utf8');
    expect(src).toMatch(/No recovery protocol is offered/);
    expect(src).toMatch(/refusing to continue — \$\{chain\.reason\}/);
  });

  it('the trust boundary is stated, not implied away', () => {
    const src = readFileSync('scripts/soak-controller.mjs', 'utf8');
    expect(src).toMatch(/TRUST BOUNDARY/);
    // It must admit the case it cannot catch, in plain words.
    expect(src).toMatch(/indistinguishable from a soak that genuinely stopped/);
  });
});
