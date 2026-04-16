# Serialized Container State APIs for External Node.js Workflows

This guide is for developers building a multi-process workflow that transports serialized Fluid container state across environments, including a network-isolated sandbox.

It is based on APIs exported from the container-loader layer and is intentionally focused on external usage (no internal API imports).

## Your target flow

1. Online process (#1): load an attached container, produce a serialized pending-state blob.
2. Offline sandbox process (#2): rehydrate from blob in memory, mutate, produce updated pending-state blob.
3. Online process (#3): load again with updated blob, reconnect, and submit sandbox-generated changes.

## API stability map (what to use)

Source of truth: API reports under packages/loader/container-loader/api-report.

- Public
  - ConnectionState (enum)
- Legacy + Beta (allowed, but not long-term modern)
  - Loader
  - loadExistingContainer(...)
  - createDetachedContainer(...)
  - rehydrateDetachedContainer(...)
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

Use legacy entrypoints when you need these loader/container capabilities:

- @fluidframework/container-loader/legacy
- @fluidframework/container-loader/legacy/alpha (only when alpha APIs are required)

## Recommended API choices for your scenario

Use these APIs for attached-container pending-state transfer:

- Loader.resolve(request, pendingLocalState?) to load/reload the attached session.
- asLegacyAlpha(container).getPendingLocalState() to serialize attached pending state.
- loadFrozenContainerFromPendingState(...) in the sandbox to avoid network dependency while applying/mutating pending state.
- waitContainerToCatchUp(container) optionally, when you want to reduce stale-read risk before extracting state.

Do not use detached serialization for this flow:

- container.serialize() and rehydrateDetachedContainer(...) are for detached containers.
- Your workflow is attached-container pending-state transfer, so use getPendingLocalState() blobs.

## Step-by-step implementation

### Step #1 (online): produce pending-state blob

```ts
import type { IRequest } from "@fluidframework/core-interfaces";
import { Loader } from "@fluidframework/container-loader/legacy";
import { asLegacyAlpha, waitContainerToCatchUp } from "@fluidframework/container-loader/legacy/alpha";

async function exportPendingStateFromOnlineProcess(
  request: IRequest,
  loader: Loader,
): Promise<string> {
  const container = await loader.resolve(request);

  // Wait for container to be caught up before snapshotting pending state.
  await waitContainerToCatchUp(container);

  // Alpha API: required for attached-container pending-state blob.
  const pendingBlob = await asLegacyAlpha(container).getPendingLocalState();

  // Ship pendingBlob to sandbox.
  return pendingBlob;
}
```

Notes:

- getPendingLocalState() requires an attached, non-closed container.
- Treat the blob as short-lived transfer state, not a durable artifact.

### Step #2 (offline sandbox): rehydrate, mutate, re-serialize

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
  baseProps: Omit<ILoadFrozenContainerFromPendingStateProps, "request" | "pendingLocalState">,
): Promise<string> {
  const container = await loadFrozenContainerFromPendingState({
    ...baseProps,
    request,
    pendingLocalState,
  });

  const entryPoint = await container.getEntryPoint();
  // Apply your in-memory mutations through your runtime/data-object APIs.
  // e.g. await entryPoint.myModel.applySandboxTransform(...)

  // Export updated pending state to send back to online environment.
  const updatedPendingBlob = await asLegacyAlpha(container).getPendingLocalState();
  return updatedPendingBlob;
}
```

Notes:

- loadFrozenContainerFromPendingState(...) is Legacy + Alpha and purpose-built for this use case.
- Keep sandbox storage-agnostic by only depending on loader abstractions (urlResolver/documentServiceFactory/codeLoader).

### Step #3 (online): re-open with sandbox blob and submit ops

```ts
import type { IRequest } from "@fluidframework/core-interfaces";
import { Loader } from "@fluidframework/container-loader/legacy";
import { ConnectionState } from "@fluidframework/container-loader/legacy";
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

  // Optional: wait until catch-up is complete.
  await waitContainerToCatchUp(container);

  //
  // Wait for the container to be saved, i.e. all the local changes to land in the file
  // But also race with container failing and timeout.
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
          // Guard in case "saved" is emitted before dirty state fully flips.
          if (!container.isDirty) {
            savedResolve();
          }
        };
        container.on("saved", onSaved);
      });

      const waitForDisposed = new Promise<never>((_, disposedReject) => {
        onDisposed = () => {
          disposedReject(new Error("Container disposed before pending ops were submitted."));
        };
        container.on("disposed", onDisposed);
      });

      const waitForTimeout = new Promise<never>((_, timeoutReject) => {
        timeoutHandle = setTimeout(() => {
          timeoutReject(new Error("Timed out after 5 minutes waiting for container to save."));
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
- Keep your existing ODSP auth/token/file-identification logic unchanged; this flow is additive around resolve/pendingLocalState.

## API quick reference for this project

- Loader.resolve(request, pendingLocalState?)
  - Stability: Legacy + Beta
  - Use: Standard attached-container load, with optional pending-state replay.

- asLegacyAlpha(container).getPendingLocalState()
  - Stability: Legacy + Alpha
  - Use: Serialize attached container pending changes and needed snapshot context.

- loadFrozenContainerFromPendingState(props)
  - Stability: Legacy + Alpha
  - Use: Rehydrate and run from pending blob with frozen document service behavior.

- waitContainerToCatchUp(container)
  - Stability: Legacy + Beta
  - Use: Optional guard before read/serialize operations.

- container.serialize() / rehydrateDetachedContainer(...)
  - Stability: Legacy + Beta
  - Use: Detached-container scenarios only (not attached pending-state transfer).

## Operational cautions

- Keep blob lifecycle short:
  - Generate, transfer, consume, then discard.
- Do not mix blobs across different documents/URLs.
- Do not call getPendingLocalState() on closed/disposed containers.
- Use a fresh blob after each mutation cycle; do not reuse an old blob after additional edits.
- Because key APIs here are legacy (beta/alpha), isolate usage behind your own adapter module so future migration is easier.

## Suggested adapter shape

Create a tiny abstraction in your app, for example:

- exportPendingState(request): Promise<string>
- runOfflineMutation(request, pendingBlob): Promise<string>
- importPendingState(request, pendingBlob): Promise<void>

This keeps legacy/alpha API contact points centralized and easy to replace later.
