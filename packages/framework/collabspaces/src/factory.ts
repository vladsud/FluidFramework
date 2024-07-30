/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
	ChannelCollectionFactory,
	ChannelCollection,
} from "@fluidframework/container-runtime/internal";
import { FluidDataStoreRuntime } from "@fluidframework/datastore/internal";
import {
	IChannelFactory,
	IFluidDataStoreRuntime,
} from "@fluidframework/datastore-definitions/internal";
import { SharedMatrix } from "@fluidframework/matrix/internal";
import {
	IFluidDataStoreChannel,
	IFluidDataStoreFactory,
	NamedFluidDataStoreRegistryEntries,
	IFluidDataStoreContext,
	NamedFluidDataStoreRegistryEntry,
} from "@fluidframework/runtime-definitions/internal";

// import { DeferredChannel, DeferredChannelFactory } from "./deferreChannel";

import { CollabSpacesRuntime } from "./collabSpaces.js";
import { IEfficientMatrix, IEfficientMatrixTest } from "./contracts.js";
import { DeferredChannelFactory } from "./deferreChannel.js";

export class MatrixDataStoreFactory implements IFluidDataStoreFactory {
	public static readonly type = "__matrixType";
	public readonly type = MatrixDataStoreFactory.type;

	public get IFluidDataStoreFactory() {
		return this;
	}

	public static get registryEntry(): NamedFluidDataStoreRegistryEntry {
		return [this.type, Promise.resolve(new MatrixDataStoreFactory())];
	}

	public async instantiateDataStore(
		context: IFluidDataStoreContext,
		existing: boolean,
	): Promise<FluidDataStoreRuntime> {
		const matrixF = SharedMatrix.getFactory();
		const dataTypes = new Map<string, IChannelFactory>();
		dataTypes.set(matrixF.type, matrixF);

		const matrixDdsId = "matrix";

		const runtime = new FluidDataStoreRuntime(
			context,
			dataTypes,
			existing,
			async (runtimeArg: IFluidDataStoreRuntime) => {
				return runtimeArg.getChannel(matrixDdsId);
			},
		);

		if (!existing) {
			const matrix = runtime.createChannel(matrixDdsId, matrixF.type) as SharedMatrix;

			// Insert row/col for tracking row/col internal IDs
			matrix.insertCols(0, 1);
			matrix.insertRows(0, 1);

			matrix.switchSetCellPolicy();

			matrix.bindToContext();
		}
		return runtime;
	}
}

class CollabSpacesFactory extends ChannelCollectionFactory {
	constructor(registryEntriesArg: NamedFluidDataStoreRegistryEntries) {
		const registryEntries: NamedFluidDataStoreRegistryEntries = [
			...registryEntriesArg,
			[DeferredChannelFactory.type, Promise.resolve(new DeferredChannelFactory())],
		];
		super(
			[
				...registryEntries,
				[MatrixDataStoreFactory.type, Promise.resolve(new MatrixDataStoreFactory())],
			],
			async (runtime: IFluidDataStoreChannel) => {
				return runtime as CollabSpacesRuntime satisfies IEfficientMatrix &
					IEfficientMatrixTest;
			},
			(...args: ConstructorParameters<typeof ChannelCollection>) =>
				new CollabSpacesRuntime(registryEntries, ...args),
		);
	}

	public async instantiateDataStore(
		context: IFluidDataStoreContext,
		existing: boolean,
	): Promise<IFluidDataStoreChannel> {
		const runtime = (await super.instantiateDataStore(
			context,
			existing,
		)) as CollabSpacesRuntime;
		await runtime.initialize(existing);
		return runtime;
	}
}

/** @internal */
export function createCollabSpaces(
	registryEntries: NamedFluidDataStoreRegistryEntries,
): IFluidDataStoreFactory {
	return new CollabSpacesFactory(registryEntries);
}
