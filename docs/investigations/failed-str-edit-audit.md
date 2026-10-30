# “failed str” session edit audit

Session: 08ddc2e3-f282-4d8a-b247-816f1d76b953. Workspace: llm desktop assistant.

Read-only inspection of the live Continuum SQLite database and recovery blobs. Replays operate on in-memory strings and temporary copies. No session data or target component was changed by this audit.

## Counts

The saved session contains 68 tool calls: 52 complete, 16 failed (23.5%). The Tooltip task spans messages 4042, 4044, and 4046: 57 calls, 14 failures. All 14 failures are edit calls. Of 19 edit calls, five succeeded and fourteen failed. The remaining two failures belong to earlier tasks.

Tooltip failures: nine unsafe-normalization, one no-match, three PATCH_CONTEXT_MISMATCH, one PATCH_ARGUMENT_INVALID.

## Evidence and attribution

- The old JSX guard rejected an entire normalized range overlapping meaningful JSX text. It also rejected a closing-tag edit while the staged batch contained an unmatched Tooltip opening tag. The guard relied on parsing the intermediate file.
- The repeated Local label target used fewer tabs than the actual source. Its text, attributes and tags otherwise matched in several requests. The guard treated indentation within the multiline JSX text node as exact-only. For this simple multiline label JSX discards that indentation during rendering; a guard based on rendered JSX text could safely accept it.
- The recent narrower guard still compares raw whitespace in meaningful JSX text, so it retains this limitation. Of ten failed string/batch requests replayed independently, nine still fail and one succeeds. The first 20-edit batch progresses from failure at edit 3 to failure at edit 7; both 12-edit batches still fail at edit 3. These are request replays, not a counterfactual end-to-end model run.
- Source snapshots came from recovery checkpoints 1717–1722. All ten old-matcher replays reproduce their recorded failure categories. Successful historical edits advance the replay source to the next saved checkpoint; each failed batch stages preceding operations in memory.
- Failure diagnostics for Local targets repeatedly returned a generic span near lines 93–101, rather than the actual label at lines 502–507. The nearby-source heuristic picks early common anchors such as `<span`, so the recovery advice is actively unhelpful. Batch excerpts also show staged, uncommitted preceding edits despite zero writes, without making that distinction explicit.
- The agent repeatedly guessed tab counts despite an awk result displaying the actual indentation. Two requests were exact repeats (recorded repeated_failure=true). Switching between string tools did not change their shared matcher.
- Three patches used incorrect indentation; changing hunk line counts did not correct their source context. One patch supplied a bare @@ header unsupported by this parser. The string no-match request omitted an existing closing span before Capabilities.
- One successful agent edit replaced an outer span with Tooltip without balancing the closing tag and supplied className to a component that ignores it. The agent identified this mistake and used two later successful edits to repair it. Tool success therefore did not imply correct code.

## Conclusion and follow-up

This is a harness/model interaction failure, not evidence that all rejections are necessary or that model capability alone explains the incident. Restrictive JSX whitespace matching and poor recovery diagnostics start and prolong the loop; repeated guessed inputs, malformed patches and an invalid successful edit amplify it.

The recent fix is insufficient for this recorded workload. Next changes should compare JSX text using JSX rendering whitespace rules, preserve significant inline spaces and literal/comment bytes, return the actual rejected normalized candidate with its exact source, distinguish staged batch content from on-disk content, and support a practical patch format/fallback. Validate with these real requests plus significant-whitespace counterexamples before claiming a lower failure rate. Avoid adding more retry restrictions as a substitute for fixing matching and diagnostics.

Replay details: failed-str-edit-replay.json (zero-based tool index within the Tooltip task; edit numbers one-based).
