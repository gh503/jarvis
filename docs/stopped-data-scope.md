# Internal stopped-data scope

Status: **upcoming source API; not yet published in a portable release**. The internal [stopped-data-scope.ts](../scripts/stopped-data-scope.ts) helper lets trusted source modules hold the launcher and runtime lifecycle locks continuously across sequential snapshot creation for one canonical data root. No CLI behavior changes, and there is no `--scope` flag.

`withStoppedDataScope(dataDir, async scope => ...)` acquires launcher then runtime locks and fails if an owner is active; it does not stop the runtime. Stop all other writers, including config editors and tools that bypass lifecycle locks, before entry and keep them stopped throughout capture. Lock preflight can update operational lock files and data-root permissions/ACLs.

## Optional config and data capture

Either capture is optional. When capturing both, await config creation and then data creation with the same explicit `dataDir` and opaque `scope` token:

```ts
import { withStoppedDataScope } from '../scripts/stopped-data-scope.ts'
import { createConfigSnapshot } from '../scripts/native-config-snapshot.ts'
import { createStateSnapshot } from '../scripts/native-state-snapshot.ts'

const dataDir = '/absolute/data'
const captures = await withStoppedDataScope(dataDir, async scope => {
  const config = await createConfigSnapshot({
    scope,
    dataDir,
    configFile: '/absolute/private-config/config.env',
    destination: '/absolute/private-snapshots/new-config',
  })
  const data = await createStateSnapshot({
    scope,
    dataDir,
    destination: '/absolute/private-snapshots/new-data',
  })
  return { config, data }
})
```

Use existing canonical absolute source paths and an existing private snapshot parent, with separate fresh destinations as above. The config must explicitly select that same `JARVIS_DATA_DIR`; its parent and the data root must be disjoint in both directions. Keep the config outside the data tree. All existing [config snapshot](native-config-snapshot.md) and [data snapshot](native-state-snapshot.md) validation, privacy, destination, and trust requirements still apply. Retain each successful snapshot's manifest digest separately in a trusted private record.

## Lifetime and failure contract

Tokens are opaque runtime capabilities backed by a private `WeakMap`, not caller-supplied lock assertions. Admission checks active lifetime, canonical root, and directory identity. Forged, expired, wrong-root, and concurrent-operation tokens/calls reject before snapshot preflight. Await every operation sequentially; do not use `Promise.all` or detach work. The first operation or admission failure remains recorded even if the callback catches it, so the outer scope cannot report false success.

If the callback finishes with an admitted operation still pending, the helper drains that operation while retaining both locks, then rejects. It does not impose a scope deadline or release locks through cancellation while work is ongoing. Individual operation limits still apply. The token expires when the scope closes and cannot be reused later. Calls without `scope` retain standalone lock ownership and the existing manifest formats; verify and restore APIs are unchanged.

This helper is for internal trusted modules, not a public arbitrary-task sandbox. It cannot prevent a callback from using raw filesystem APIs. Locks coordinate participating writers only; they do not provide an OS sandbox, an atomic multi-file capture, power-loss durability, or protection against hostile same-account mutation.

There is **no aggregate recovery manifest or bound recovery set** yet. A later operation's failure may leave an earlier snapshot complete and another destination partial; there is no rollback of the capture sequence. Each snapshot keeps its own manifest and verification contract. The scope does not capture installer receipts or installed version identity, bind snapshots to a baseline binary, or resolve cross-version configuration/database compatibility. Full recovery-set binding and transactional activation remain deferred; retain the original config, stopped data, and compatible binary.
