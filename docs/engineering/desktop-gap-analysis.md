# MobiusX Desktop P0 gap analysis

This analysis is limited to P0 generation reliability and executable evidence.

| Severity | Gap | Evidence | P0 remediation / acceptance |
|---|---|---|---|
| High | A code-writing mode could retain Laya's `image_generation` workload label when a website prompt mentioned product imagery. MobiusX has no image-generation runner, so this could send a software build down an unsupported workload path and show a misleading image failure. | Existing Garden request log begins with an image-generation failure; `routeWithLaya` trusted the classifier's workload choice even when `mode` was `build`. | Force code-writing task modes to `coding`; test a gardening prompt classified as image generation and confirm the final route remains coding. |
| Critical | No customer onboarding/approval reference project is present, so the required persisted transaction and automated business workflow cannot currently be proven from repository artifacts. | Inspected generated project directories; only unrelated GardenApp and employee-onboarding samples were present. | Generate or add the prescribed reference app through MobiusX, then prove create → submit → manager decision → persisted status/audit history with automated tests. |
| High | Live model generation could not be reproduced in this environment. | `127.0.0.1:11434` refused connection; cloud-provider calls were not run. | Re-run the same approved prompt in the desktop app with a reachable authorized provider and retain task/artifact evidence. |
| Medium | Desktop-agent full suite cannot be fully verified in this execution environment. | 179/184 passed; 3 terminal tests cannot bind under sandbox restrictions and 2 browser/Pytest tests skip for missing tools. Elevated retry stalled in terminal websocket tests. | Run the terminal and browser tests in the normal desktop environment; retain the failures as visible gates. |
| Medium | Default Turbopack build execution is sandbox-sensitive even though Webpack compilation succeeds. | GardenApp `next build` failed while creating a local CSS worker; `next build --webpack` succeeded. | Validate preview/build under MobiusX's actual desktop process environment and report the selected bundler and evidence. |

The model-provider credit and malformed-response errors in the supplied Garden run are distinct provider failures. Existing Auto Cloud recovery/failover code can retry configured candidates, but it cannot produce files when every configured provider returns an unusable response or has no available credits.
