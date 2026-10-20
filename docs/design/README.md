# System diagrams

- `01-deployment.html` — Where do the browser clients and VPS services run, and how are OSRM artifacts built and deployed?
- `02a-data-model-planning.html` — How does a dated Plan diario assign Recorridos and Traslados, and how are route versions and constraints represented?
- `02b-data-model-execution.html` — What marks, corrections, audit records, recipients, and plan acknowledgements are retained?
- `03-states.html` — Which Traslado and Recorrido transitions are allowed, how are marks corrected, and when is close blocked?
- `04-sequence-absence-replan.html` — How does an absence trigger a validated, versioned re-plan and driver acknowledgement?
- `05-sequence-offline-mark.html` — How are marks recipient-checked offline, retried after restore, and retained until end-of-day cleanup?
- `06-swimlane-operating-day.html` — How do Oficina, System, Chofer, and Family coordinate the prior evening, operating day, and close?
