# M1 — Host memory attribution

2026-10-29, Asia/Dhaka. **No precise cause of the reported approximately 10 GB host-RAM delta is established. No memory code or configuration was changed.** Saved configuration and production launch/lifecycle paths were inspected. No model process is visible in this sandbox's process namespace, and NVIDIA driver telemetry is unavailable. [Evidence JSON](m1-host-memory-attribution-evidence.json).

## Observation versus independent evidence

The user reported approximately 16 GB system RAM while Qwen was loaded, approximately 6 GB after unloading, and about 13/16 GB VRAM usage. These are user observations, not independently reproduced measurements. System-wide used RAM is not llama-server RSS or PSS. A loaded/unloaded difference alone cannot establish CPU-resident model weights.

Read-only SQLite inspection found the remembered configuration for `Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf`, updated `2026-10-28 21:06:19`. The saved projector matches the BF16 Qwen projector beside the model. Reading GGUF header metadata through the existing scanner establishes architecture `qwen35` and one MTP layer. This bounded metadata read did not load model weights into an inference engine.

| Setting | Persisted value / launcher translation |
|---|---|
| Context | 45,312 → `-c 45312` |
| GPU layers | 99,999 → `-ngl 99999` |
| Threads | 4 → `-t 4` |
| Evaluation batch | 2,048 → `-b 2048` |
| Microbatch | 512 → `-ub 512` |
| Parallel slots | 1 → `-np 1` |
| Flash attention | auto → `-fa auto` |
| K/V precision | q8_0 / q8_0 |
| KV location | GPU requested; no `--no-kv-offload` |
| Projector | remembered BF16 projector; `--mmproj … --no-mmproj-offload` |
| MTP | enabled + one header layer → `--spec-type draft-mtp` |
| Reasoning format | deepseek |
| Load mode | **auto**; no explicit `--load-mode` emitted |
| mlock | false; no `--mlock` emitted |

The saved load mode contradicts the reported disabled mmap. The launch modal describes auto as the backend default. It is not evidence that the historical process actually used or disabled mmap. We did not change this setting.

## Arguments and runtime uncertainty

The exact production `buildLlamaServerArgs` output reconstructed from saved settings, actual header metadata and the remembered projector is in JSON. With illustrative port 8080 and shortened paths it is:

```text
-m <Qwen IQ3_S-mtp.gguf> --jinja -c 45312 -ngl 99999 -t 4
-b 2048 -ub 512 -np 1 -fa auto
--cache-type-k q8_0 --cache-type-v q8_0 --spec-type draft-mtp
--reasoning-format deepseek --port 8080
--mmproj <mmproj-Qwen3.8-27B-BF16.gguf> --no-mmproj-offload
```

This is a reconstruction, **not captured historical argv**. Historical port, executable selection, environment overrides, active rather than remembered settings and actual backend allocations are unavailable. The launcher resolves `CONTINUUM_LLAMA_SERVER` or `llama-server` and spawns direct argv with `shell:false`, `detached:true`. The visible `/usr/local/bin/llama-server` symlink points to an unavailable `/media/…` build, so backend source/defaults could not be inspected here. No engine executable was run.

`buildLlamaServerEnv` inherits most environment settings, removes authentication variables, adds local CORS settings and raises log verbosity for offload diagnostics. Thus argv alone cannot establish all backend options. No historical inherited environment was captured. Logs confirming actual offloaded layer counts, CPU/GPU KV placement and compute/staging allocations were not available.

The GPU preflight is advisory and does not make an explicit numeric layer request a guarantee that allocations succeeded. Current code emits the numeric request correctly; no evidence establishes unintended CPU placement or silently mistranslated settings.

## Lifecycle and telemetry

`main.js:launchProcess` prevents duplicate launches while launching or while a child process is owned. It associates startup handlers, runtime identity, idle service and close/error callbacks with that particular process. Stale exits cannot clear a replacement engine's state. stdout/stderr go to the renderer and the startup parser; this path does not persist a complete allocation log.

`stopEngine` cancels startup and signals the owned process tree with SIGTERM; after two seconds it escalates to SIGKILL if the same process remains. The close handler clears child/pid, active model configuration, runtime identity, capabilities, offload diagnostics and tokenizer cache. Model switches await close. The source therefore intends actual process termination, not just clearing a UI flag. A successful stop request is not itself proof that close occurred.

No current process RSS/PSS, anonymous/private/shared mappings, locked pages or before/after process list could be obtained for the historical engine. Process exit would release its address space; driver accounting and OS cache changes require separate observation. There is no evidence here of a leaked allocation, duplicate process, zombie/orphan or independently growing Electron process. Absence of a process in this namespace does not prove none runs elsewhere on the host.

`gpuMemory.js` queries NVIDIA total/free VRAM and estimates load requirements. `memoryEstimate.mjs` estimates model weights, KV, projector and buffers from metadata. These are advisory estimates, not process RSS/PSS; comments explicitly exclude OS, driver, allocator and page-cache overhead. No concrete telemetry calculation defect was established.

The independently sampled `/proc/meminfo` values and UTC timestamp are in JSON. That snapshot is system-wide, taken without a visible model and without a paired unload observation. It must not be subtracted from the user's historical approximate RAM values. `nvidia-smi` failed to communicate with the driver, so no independent VRAM value is asserted.

## Allocation hypotheses, not established causes

The model file is 12,120,016,960 bytes; the projector file is 931,146,528 bytes. File size is neither RSS nor runtime buffer size. A CPU projector is requested and therefore warrants measurement, but its file size alone cannot explain a 10 GB delta.

Potential contributors to inspect include CPU tensors and bookkeeping, non-mmap host loading buffers, staging or pinned allocations, CPU/GPU compute buffers, MTP state, CPU projector buffers, retained file mappings/page cache, and Electron's independent memory. The supplied observations do not establish which exist, their sizes or whether initialization buffers persist after GPU transfer. No claim is made that disabled mmap necessarily retains a full CPU weight copy. Actual load mode is unverified in this incident.

A CPU KV cache is not requested; actual placement still needs allocation logs. There is one requested slot, so a multi-slot configuration error is not demonstrated. Numeric full-offload intent and reported VRAM occupancy do not prove every tensor resides only on GPU.

**Confirmed conclusion:** saved flags request GPU layers/KV and CPU projector; auto load mode differs from the reported mmap setting. **Unresolved:** exact runtime argv/environment, offloaded layers, mmap use, RSS/PSS allocation breakdown, transient versus persistent host buffers, and unload accounting. None justifies a memory code change.

## Deterministic regression results

Existing GPU/offload tests pass 21/21, model-memory estimates 10/10, lifecycle 7/7, warmup 4/4. Direct engine-launch tests pass duplicate prevention, stale-process ownership, direct spawn and unload lifecycle checks. Idle and advanced model-load-setting scripts pass default/explicit load-mode, KV precision/placement, projector, persistence and CLI translation checks. The model-load test reports skipped live binary flag verification because the executable is unavailable. These use fixtures/mocks, not GPU hardware.

`engineSettings` fails its preexisting defaults assertion: expected object omits current notificationSounds and recovery retention/storage fields. Identical failure was reproduced against the disposable pre-C9.2 source. No unrelated settings test was changed. `npm run build` and `git diff --check` pass. No speculative GPU-dependent test or memory fix was added.

## Manual before/after attribution procedure

This procedure was **not executed**. Loading, unloading or restarting requires separate explicit authorization; if a compatible engine is already running, only passive capture is needed initially.

1. Identify the actual owned PID from Continuum's terminal status, cross-check its executable and `/proc/<PID>/cmdline`. Save actual argv, selected backend identity and only relevant nonsecret `LLAMA_ARG_*` settings; do not dump unrelated environment secrets.
2. Save the startup allocation log, including load mode/mmap, offloaded N/M layers, CPU/CUDA/model/projector buffers, KV placement/sizes, compute buffers, MTP and slot/context details. Do not change configuration to make it match the remembered settings.
3. At a settled idle point record the timestamp, `ps -p <PID> -o pid,rss,vsz,%mem,comm`, `/proc/<PID>/smaps_rollup`, `/proc/<PID>/status` (VmRSS/VmLck), and relevant mappings in `smaps`. Separate anonymous/private from file-backed/shared memory; prefer PSS for shared attribution. Record Electron main/renderer PSS separately.
4. Simultaneously record MemTotal, MemAvailable, MemFree, Cached, SReclaimable, Shmem and Unevictable from `/proc/meminfo`, plus `nvidia-smi` GPU totals and compute-process VRAM. Label units and timestamps. System used RAM and summed RSS are not interchangeable.
5. Only after authorized unload, record lifecycle stop/close events and verify the PID/process group is gone, then repeat system, Electron and GPU measurements at settled intervals. Record cache retention separately from live private allocations; do not drop OS caches.
6. If substantial host memory remains while loaded, reconcile startup CPU/projector buffers with anonymous/private PSS and mapped file pages. If accounting is still unexplained, collect backend-specific allocation instrumentation in a disposable follow-up, without upgrading or rewriting the engine.

No live storage was mutated. No model was loaded, unloaded, restarted or benchmarked. Investigation stops at M1 with attribution unresolved.
