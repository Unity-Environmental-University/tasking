# graph.* — minimal MCP interface contract for qigong movements

**Status**: draft (play/loop-experiments branch)
**Context**: task 70 — what do qigong movements actually need from a graph substrate?

## The question

Qigong movements currently call `edge` (a CLI backed by rhizome-alkahest/PostgreSQL). But the movements describe *operations on a graph*, not *operations on PostgreSQL*. If another substrate implemented these operations, movements would work unchanged.

What's the minimal contract?

## Operations movements actually use

Derived from grepping all movement files for `edge` calls:

### Required (every movement uses these)

| Operation | Signature | Purpose |
|-----------|-----------|---------|
| `graph.orient` | `() → OrientationMap` | Read the field — what's entering, glowing, recent |
| `graph.ran` | `(movement: string) → PriorDeposits[]` | Register a movement run, retrieve what prior instances deposited |
| `graph.add` | `(s, p, o, {phase?, note?, confidence?}) → EdgeId` | Record an observation or deposit |

### Common (most movements)

| Operation | Signature | Purpose |
|-----------|-----------|---------|
| `graph.true` | `(s, p, o) → EdgeId` | Assert something true (writes to the "truths" frame) |
| `graph.iam` | `(who: string) → Frame` | Establish observer frame |
| `graph.dissolve` | `(s, p, o) → void` | Soft-delete an edge (play frame cleanup, state transitions) |

### Occasional (some movements)

| Operation | Signature | Purpose |
|-----------|-----------|---------|
| `graph.find` | `(term: string) → Edge[]` | Search the graph |
| `graph.about` | `(subject: string) → Edge[]` | Edges from a subject |
| `graph.parallax` | `() → Disagreement[]` | Where observers disagree |

## Phase vocabulary

Phases are metadata on edges, not separate storage:

| Phase | Meaning | When |
|-------|---------|------|
| `fluid` | In motion, may change | Most deposits |
| `salt` | Precipitated, crystallized | Completed work, settled decisions |
| `volatile` | Speculative, may evaporate | Low-confidence observations, play |

## What this means for implementation

A substrate implements the graph.* contract if it can:

1. Store triples (subject, predicate, object) with optional phase/note/confidence
2. Soft-delete (dissolve) edges without destroying them
3. Track observer identity (who said this)
4. Aggregate recent activity into an orientation map
5. Track movement runs and their deposits

That's it. PostgreSQL does this. A JSON file could do this. An in-memory store could do this for a single session.

## What this does NOT need to be

- Not an ontology or schema language
- Not a query language (orient/find/about are convenience, not computation)
- Not a type system (phases are conventions, not enforced)
- The interface is the contract. Alkahest salt on the interface definition itself is the type registry — the graph knows what shapes plug into it.

## As MCP tools

If exposed as MCP tools, the minimal set:

```
graph_orient    → {}                                      → { entering[], glowing[], recent[] }
graph_ran       → { movement: string }                    → { prior_deposits[] }
graph_add       → { s, p, o, phase?, note?, confidence? } → { id }
graph_true      → { s, p, o }                             → { id }
graph_iam       → { who: string }                         → { frame }
graph_dissolve  → { s, p, o }                             → {}
graph_find      → { term: string }                        → { edges[] }
```

Seven tools. A movement that works with these works with any graph that implements them.
