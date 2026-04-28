# Serialized Container State APIs - Create Scenario

This guide covers the create scenario: a network-isolated sandbox creates a new detached Fluid container, mutates it, serializes it, and sends that blob to an online service that rehydrates and attaches to ODSP.

This is focused on external usage from the container-loader package and does not use internal imports.

## Scenario flow

1. Offline sandbox process (#1): create a detached container.
2. Offline sandbox process (#2): mutate container state in memory.
3. Offline sandbox process (#3): call `serialize()` and ship blob to service.
4. Online service process (#4): rehydrate detached container from blob.
5. Online service process (#5): call `attach(request)` to create the file in ODSP.

## API stability map

Source of truth: API reports under packages/loader/container-loader/api-report.

- Public
  - ConnectionState (enum)
- Legacy + Beta (allowed, but not long-term modern)
  - createDetachedContainer(...)
  - rehydrateDetachedContainer(...)
  - Loader
- Legacy + Alpha (allowed with extra caution)
  - none required for this scenario

## Do not use internal APIs

For external code, do not import from:

- @fluidframework/container-loader/internal
- @fluidframework/container-definitions/internal
- any path containing /internal/test/

Use legacy entrypoints for this scenario:

- @fluidframework/container-loader/legacy

## Recommended API choices

Use these APIs for the create scenario:

- createDetachedContainer(...) to start a brand-new detached session.
- container.serialize() to export detached state from sandbox.
- rehydrateDetachedContainer(...) or `Loader.rehydrateDetachedContainerFromSnapshot(...)` in the service.
- container.attach(request) to create the new file in ODSP.

Do not use attached pending-state APIs for this scenario:

- `getPendingLocalState()` and `Loader.resolve(request, pendingLocalState)` are for existing attached documents.

## Step-by-step implementation

### Step C1 (offline sandbox): create detached container, mutate, serialize

```ts
import {
  createDetachedContainer,
  type ICreateDetachedContainerProps,
} from "@fluidframework/container-loader/legacy";

async function createDetachedBlobInSandbox(
  codeDetails: ICreateDetachedContainerProps["codeDetails"],
  baseProps: Omit<ICreateDetachedContainerProps, "codeDetails">,
): Promise<string> {
  const container = await createDetachedContainer({
    ...baseProps,
    codeDetails,
  });

  const entryPoint = await container.getEntryPoint();
  // Apply in-memory mutations through your runtime/data-object APIs.
  // e.g. await entryPoint.myModel.initializeTemplate(...)

  return container.serialize();
}
```

Notes:

- `serialize()` is valid only while the container is detached and not closed.
- The serialized payload here is a detached snapshot payload.

### Step C2 (online service): rehydrate detached blob and attach to ODSP

```ts
import type { IRequest } from "@fluidframework/core-interfaces";
import {
  rehydrateDetachedContainer,
  type IRehydrateDetachedContainerProps,
} from "@fluidframework/container-loader/legacy";

async function importDetachedBlobAndAttach(
  createRequest: IRequest,
  detachedSerializedState: string,
  baseProps: Omit<IRehydrateDetachedContainerProps, "serializedState">,
): Promise<void> {
  const container = await rehydrateDetachedContainer({
    ...baseProps,
    serializedState: detachedSerializedState,
  });

  await container.attach(createRequest);

  // Optional: persist new document identity after attach.
  // const id = container.resolvedUrl?.id;
}
```

### Step C3 (optional): Loader instance method variant

```ts
import type { IRequest } from "@fluidframework/core-interfaces";
import { Loader } from "@fluidframework/container-loader/legacy";

async function importWithLoaderMethod(
  loader: Loader,
  createRequest: IRequest,
  detachedSerializedState: string,
): Promise<void> {
  const container = await loader.rehydrateDetachedContainerFromSnapshot(
    detachedSerializedState,
  );
  await container.attach(createRequest);
}
```

## Operational cautions

- Keep blob lifecycle short:
  - Generate, transfer, consume, then discard.
- Do not pass detached `serialize()` blobs into `Loader.resolve(..., pendingLocalState)`.
- Do not call `serialize()` after attach.
- Treat `attach()` as a one-time transition from detached to attached.
- Isolate these legacy API touchpoints behind a small adapter for easier migration later.

## Companion guide

For editing an existing attached document through pending state blobs, see [SERIALIZED_CONTAINER_STATE_APIS.md](SERIALIZED_CONTAINER_STATE_APIS.md).
