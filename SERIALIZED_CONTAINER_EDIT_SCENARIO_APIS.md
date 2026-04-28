# Serialized Container State APIs - Edit Scenario

This guide covers the edit scenario: an existing attached document is loaded online, serialized as pending local state, sent to an isolated sandbox for local mutation, then sent back and replayed online.

This is focused on external usage from the container-loader package and does not use internal imports.

## Scenario flow

1. Online process (#1): load an attached container and produce a pending-state blob.
2. Offline sandbox process (#2): rehydrate from pending-state blob, mutate, produce updated pending-state blob.
3. Online process (#3): load again with updated pending-state blob, reconnect, and submit sandbox-generated changes.

## API stability map

Source of truth: API reports under packages/loader/container-loader/api-report.

- Public
  - ConnectionState (enum)
- Legacy + Beta (allowed, but not long-term modern)
  - Loader
  - loadExistingContainer(...)
  - waitContainerToCatchUp(...)
  - ILoadExistingContainerProps and related loader prop types
- Legacy + Alpha (allowed with extra caution)
  - ContainerAlpha
  - asLegacyAlpha(...)
  - ContainerAlpha.getPendingLocalState()
  - loadFrozenContainerFromPendingState(...)
  - PendingLocalStateStore

## Do not use internal APIs

For external code, do not import from:

- @fluidframework/container-loader/internal
- @fluidframework/container-definitions/internal
- any path containing /internal/test/

Use legacy entrypoints for this scenario:

- @fluidframework/container-loader/legacy
- @fluidframework/container-loader/legacy/alpha (only when alpha APIs are required)

## Recommended API choices

Use these APIs for the edit scenario:

- Loader.resolve(request, pendingLocalState?) to load or reload an attached session.
- asLegacyAlpha(container).getPendingLocalState() to serialize attached pending state.
- loadFrozenContainerFromPendingState(...) in sandbox code to avoid network dependency while mutating.
- waitContainerToCatchUp(container) optionally before extracting state to reduce stale-read risk.

Do not use detached serialization APIs for this scenario:

- container.serialize() and rehydrateDetachedContainer(...) are for detached container creation flows.

## Step-by-step implementation

### Step E1 (online): produce pending-state blob

```ts
import type { IRequest } from "@fluidframework/core-interfaces";
import { Loader } from "@fluidframework/container-loader/legacy";
import {
  asLegacyAlpha,
  waitContainerToCatchUp,
} from "@fluidframework/container-loader/legacy/alpha";

async function exportPendingStateFromOnlineProcess(
  request: IRequest,
  loader: Loader,
): Promise<string> {
  const container = await loader.resolve(request);

  // Optional but recommended when stale reads are a concern.
  await waitContainerToCatchUp(container);

  const pendingBlob = await asLegacyAlpha(container).getPendingLocalState();
  return pendingBlob;
}
```

Notes:

- getPendingLocalState() requires an attached, non-closed container.
- Treat the blob as short-lived transfer state, not a durable artifact.

### Step E2 (offline sandbox): rehydrate, mutate, re-serialize

```ts
import type { IRequest } from "@fluidframework/core-interfaces";
import {
  loadFrozenContainerFromPendingState,
  type ILoadFrozenContainerFromPendingStateProps,
} from "@fluidframework/container-loader/legacy/alpha";
import { asLegacyAlpha } from "@fluidframework/container-loader/legacy/alpha";

async function runSandboxMutation(
  request: IRequest,
  pendingLocalState: string,
  baseProps: Omit<
    ILoadFrozenContainerFromPendingStateProps,
    "request" | "pendingLocalState"
  >,
): Promise<string> {
  const container = await loadFrozenContainerFromPendingState({
    ...baseProps,
    request,
    pendingLocalState,
  });

  const entryPoint = await container.getEntryPoint();
  // Apply your in-memory mutations through your runtime/data-object APIs.
  // e.g. await entryPoint.myModel.applySandboxTransform(...)

  return asLegacyAlpha(container).getPendingLocalState();
}
```

Notes:

- loadFrozenContainerFromPendingState(...) is Legacy + Alpha and purpose-built for this use case.
- Keep sandbox code storage-agnostic by only depending on loader abstractions.

### Step E3 (online): replay sandbox blob and submit ops

```ts
import type { IRequest } from "@fluidframework/core-interfaces";
import { ConnectionState, Loader } from "@fluidframework/container-loader/legacy";
import { waitContainerToCatchUp } from "@fluidframework/container-loader/legacy/alpha";

async function importSandboxChanges(
  request: IRequest,
  loader: Loader,
  sandboxPendingBlob: string,
): Promise<void> {
  const container = await loader.resolve(request, sandboxPendingBlob);

  if (container.connectionState === ConnectionState.Disconnected) {
    container.connect();
  }

  await waitContainerToCatchUp(container);

  if (container.isDirty) {
    await new Promise<void>((resolve, reject) => {
      const timeoutMs = 5 * 60 * 1000;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let onSaved: (() => void) | undefined;
      let onDisposed: (() => void) | undefined;

      const cleanup = (): void => {
        if (onSaved !== undefined) {
          container.off("saved", onSaved);
        }
        if (onDisposed !== undefined) {
          container.off("disposed", onDisposed);
        }
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
      };

      const waitForSaved = new Promise<void>((savedResolve) => {
        if (!container.isDirty) {
          savedResolve();
          return;
        }
        onSaved = () => {
          if (!container.isDirty) {
            savedResolve();
          }
        };
        container.on("saved", onSaved);
      });

      const waitForDisposed = new Promise<never>((_, disposedReject) => {
        onDisposed = () => {
          disposedReject(
            new Error("Container disposed before pending ops were submitted."),
          );
        };
        container.on("disposed", onDisposed);
      });

      const waitForTimeout = new Promise<never>((_, timeoutReject) => {
        timeoutHandle = setTimeout(() => {
          timeoutReject(
            new Error("Timed out after 5 minutes waiting for container to save."),
          );
        }, timeoutMs);
      });

      Promise.race([waitForSaved, waitForDisposed, waitForTimeout]).then(
        () => {
          cleanup();
          resolve();
        },
        (error) => {
          cleanup();
          reject(error as Error);
        },
      );
    });
  }
}
```

Notes:

- You can also use loadExistingContainer({ request, pendingLocalState, ...services }) instead of Loader.resolve(...).
- Keep existing ODSP auth/token/file-identification logic unchanged; this flow is additive around resolve and pending state replay.

## API quick reference

- Loader.resolve(request, pendingLocalState?)
  - Stability: Legacy + Beta
  - Use: Standard attached-container load with optional pending-state replay.

- asLegacyAlpha(container).getPendingLocalState()
  - Stability: Legacy + Alpha
  - Use: Serialize attached container pending changes and snapshot context.

- loadFrozenContainerFromPendingState(props)
  - Stability: Legacy + Alpha
  - Use: Rehydrate and run from a pending-state blob with frozen document service behavior.

- waitContainerToCatchUp(container)
  - Stability: Legacy + Beta
  - Use: Optional guard before read/serialize operations.

## Operational cautions

- Keep blob lifecycle short:
  - Generate, transfer, consume, then discard.
- Do not mix blobs across different documents/URLs.
- Do not call getPendingLocalState() on closed or disposed containers.
- Use a fresh blob after each mutation cycle; do not reuse old blobs after additional edits.
- Because key APIs here are legacy (beta/alpha), isolate usage behind a small adapter for easier migration.

## Companion guide

For creating a new document via detached create/serialize/rehydrate/attach, see [SERIALIZED_CONTAINER_CREATE_SCENARIO_APIS.md](SERIALIZED_CONTAINER_CREATE_SCENARIO_APIS.md).
