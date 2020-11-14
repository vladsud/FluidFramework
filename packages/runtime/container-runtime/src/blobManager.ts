/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IFluidHandle,
    IFluidRoutingContext,
    IFluidRoutingContextEx,
    IRequest,
} from "@fluidframework/core-interfaces";
import { IDocumentStorageService } from "@fluidframework/driver-definitions";
import { generateHandleContextPath, FluidRoutingContext } from "@fluidframework/runtime-utils";
import { AttachmentTreeEntry } from "@fluidframework/protocol-base";
import { ISnapshotTree, ITree } from "@fluidframework/protocol-definitions";

/**
 * This class represents blob (long string)
 * This object is used only when creating (writing) new blob and serialization purposes.
 * De-serialization process goes through FluidObjectHandle and request flow:
 * DataObject.request() recognizes requests in the form of `/blobs/<id>`
 * and loads blob.
 */
export class BlobHandle implements IFluidHandle<ArrayBufferLike> {
    public get IFluidHandle(): IFluidHandle { return this; }

    public get isAttached(): boolean {
        return true;
    }

    public readonly absolutePath: string;

    constructor(
        public readonly path: string,
        public readonly routeContext: IFluidRoutingContext,
        public get: () => Promise<any>,
        public attachGraph: () => void,
    ) {
        this.absolutePath = generateHandleContextPath(path, this.routeContext);
    }

    public bind(handle: IFluidHandle) {
        throw new Error("Cannot bind to blob handle");
    }
}

export class BlobManager {
    public static readonly basePath = "_blobs";
    protected readonly routeContext: IFluidRoutingContextEx;
    private readonly blobIds: Set<string> = new Set();

    constructor(
        rootRoute: IFluidRoutingContextEx,
        private readonly getStorage: () => IDocumentStorageService,
        private readonly sendBlobAttachOp: (blobId: string) => void)
    {
        this.routeContext = new FluidRoutingContext(
            "_blobs",
            rootRoute,
            undefined,
            async (request: IRequest, route?: string) => {
                if (route !== undefined) {
                    const handle = await this.getBlob(route);
                    if (handle) {
                        return { status: 200, mimeType: "fluid/object", value: await handle.get() };
                    }
                }
                return { status: 404, mimeType: "text/plain", value: `${request.url} not found` };
            });
    }

    public async getBlob(blobId: string): Promise<IFluidHandle<ArrayBufferLike>> {
        return new BlobHandle(
            blobId,
            this.routeContext,
            async () => this.getStorage().readBlob(blobId),
            () => null,
        );
    }

    public async createBlob(blob: ArrayBufferLike): Promise<IFluidHandle<ArrayBufferLike>> {
        const response = await this.getStorage().createBlob(blob);

        const handle = new BlobHandle(
            response.id,
            this.routeContext,
            async () => this.getStorage().readBlob(response.id),
            () => this.sendBlobAttachOp(response.id),
        );

        return handle;
    }

    public addBlobId(blobId: string) {
        this.blobIds.add(blobId);
    }

    /**
     * Load a set of previously attached blob IDs from a previous snapshot. Note
     * that BlobManager tracking and reporting attached blobs is a temporary
     * solution since storage expects attached blobs to be reported and any that
     * are not reported as attached may be GCed. In the future attached blob
     * IDs will be collected at summarization time, and runtime will not care
     * about the existence or specific formatting of this tree in returned
     * snapshots.
     *
     * @param blobsTree - Tree containing IDs of previously attached blobs. This
     * corresponds to snapshot() below. We look for the IDs in the blob entries
     * of the tree since the both the r11s and SPO drivers replace the
     * attachment types returned in snapshot() with blobs.
     */
    public load(blobsTree?: ISnapshotTree): void {
        if (blobsTree) {
            Object.values(blobsTree.blobs).map((entry) => this.addBlobId(entry));
        }
    }

    public snapshot(): ITree {
        const entries = [...this.blobIds].map((id) => new AttachmentTreeEntry(id, id));
        return { entries, id: null };
    }
}
