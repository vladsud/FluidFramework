/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { AttachState } from "@fluidframework/container-definitions";
import {
	FluidObject,
	IFluidHandleInternal,
	IRequest,
	IResponse,
} from "@fluidframework/core-interfaces/internal";
import { assert } from "@fluidframework/core-utils/internal";
import { FluidObjectHandle } from "@fluidframework/datastore/internal";
import { type ISequencedDocumentMessage } from "@fluidframework/driver-definitions/internal";
import { readAndParse } from "@fluidframework/driver-utils/internal";
import {
	IFluidDataStoreContext,
	ITelemetryContext,
	IGarbageCollectionData,
	IInboundSignalMessage,
	IFluidDataStoreChannel,
	ISummaryTreeWithStats,
} from "@fluidframework/runtime-definitions/internal";
import { createSingleBlobSummary } from "@fluidframework/shared-object-base/internal";

import { ICollabChannelFactory } from "./contracts.js";

const snapshotFileName = "header";

/**
 * Deferred Channel
 */
export class DeferredChannel implements IFluidDataStoreChannel {
	readonly type = DeferredChannel.Type;
	static readonly Type = "CollabSpaceDeferredChannelType";

	private ops: ISequencedDocumentMessage[] = [];

	public readonly entryPoint: IFluidHandleInternal<FluidObject>;
	public get id() {
		return this.dataStoreContext.id;
	}

	public getOps() {
		return this.ops;
	}

	public constructor(protected readonly dataStoreContext: IFluidDataStoreContext) {
		this.entryPoint = new FluidObjectHandle<FluidObject>(
			{},
			"",
			this.dataStoreContext.IFluidHandleContext,
		);
	}

	public async loadExisting(): Promise<void> {
		const blobId = this.dataStoreContext.baseSnapshot?.blobs[snapshotFileName];
		assert(blobId !== undefined, "deferred channel not serialized correctly");
		this.ops = await readAndParse<ISequencedDocumentMessage[]>(
			this.dataStoreContext.storage,
			blobId,
		);
	}

	public get value(): number {
		assert(false, "should not be called");
		return 0;
	}

	public getAttachSummary(telemetryContext?: ITelemetryContext): ISummaryTreeWithStats {
		assert(false, "should not be called");
	}

	// TBD(PRI0): NYI
	getAttachGCData(telemetryContext?: ITelemetryContext): IGarbageCollectionData {
		throw new Error("NYI");
	}

	// TBD(PRI2): Implement?
	public async getGCData(fullGC?: boolean): Promise<IGarbageCollectionData> {
		return { gcNodes: {} };
	}

	public updateUsedRoutes(usedRoutes: string[]): void {}

	public process(
		message: ISequencedDocumentMessage,
		local: boolean,
		localOpMetadata: unknown,
		addedOutboundReference?: (fromNodePath: string, toNodePath: string) => void,
	): void {
		this.ops.push(message);
	}

	public async summarize(
		fullTree?: boolean,
		trackState?: boolean,
		telemetryContext?: ITelemetryContext,
	): Promise<ISummaryTreeWithStats> {
		return createSingleBlobSummary(snapshotFileName, JSON.stringify(this.ops));
	}

	/* Noop or non-callable methods */

	public processSignal(message: IInboundSignalMessage, local: boolean): void {
		assert(false, "should not be called");
	}

	public dispose() {}

	public get disposed(): boolean {
		assert(false, "should not be called");
		return false;
	}
	public makeVisibleAndAttachGraph() {
		this.dataStoreContext.makeLocallyVisible();
	}

	public setConnectionState(connected: boolean, clientId?: string) {}

	public reSubmit(type: string, content: any, localOpMetadata: unknown) {
		assert(false, "should not be called");
	}

	public async applyStashedOp(content: any): Promise<unknown> {
		assert(false, "should not be called");
	}

	public async request(request: IRequest): Promise<IResponse> {
		assert(false, "should not be called");
	}

	public setAttachState(attachState: AttachState.Attaching | AttachState.Attached): void {}
}

/**
 * Deferred Channel Factory
 */
export class DeferredChannelFactory implements ICollabChannelFactory {
	get IFluidDataStoreFactory() {
		return this;
	}

	public static readonly type = DeferredChannel.Type;
	public readonly type = DeferredChannel.Type;

	public async instantiateDataStore(
		context: IFluidDataStoreContext,
		existing: boolean,
	): Promise<IFluidDataStoreChannel> {
		const channel = new DeferredChannel(context);
		assert(existing, "existing");
		await channel.loadExisting();
		return channel;
	}

	public async create2(context: IFluidDataStoreContext, initialValue: unknown) {
		assert(initialValue === undefined, "initial value");
		const channel = new DeferredChannel(context);
		return channel;
	}
}
