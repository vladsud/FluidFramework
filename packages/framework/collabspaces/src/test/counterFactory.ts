/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
	DataObject,
	DataObjectFactory,
	IDataObjectProps,
} from "@fluidframework/aqueduct/internal";
import { assert } from "@fluidframework/core-utils/internal";
import { SharedCounter } from "@fluidframework/counter/internal";
import { type IFluidDataStoreRuntime } from "@fluidframework/datastore-definitions/internal";
import {
	IFluidDataStoreContext,
	IFluidDataStoreChannel,
} from "@fluidframework/runtime-definitions/internal";

import { ICollabChannel, ICollabChannelFactory } from "../contracts.js";

export interface ISharedCounter extends ICollabChannel {
	value: number;
	readonly ICollabChannel: ICollabChannel;
	increment(incrementAmount: number): void;
}

class TestDataObjectFactory
	extends DataObjectFactory<TestDataObject>
	implements ICollabChannelFactory
{
	async create2(context: IFluidDataStoreContext, initialValue: unknown) {
		const channel = (await this.instantiateDataStore(
			context,
			false /* existing */,
		)) as IFluidDataStoreRuntime & IFluidDataStoreChannel;

		const counter = (await channel.getChannel("counter")) as SharedCounter;
		counter.increment(initialValue as number);

		return channel;
	}
}

export class TestDataObject extends DataObject implements ISharedCounter {
	public static readonly Type = "sameple-test-data-object";

	public static readonly factory = new TestDataObjectFactory(
		TestDataObject.Type,
		TestDataObject,
		[SharedCounter.getFactory()],
		{},
	);

	private _counter?: SharedCounter;

	public get ICollabChannel() {
		return this;
	}

	public get value(): number {
		assert(this._counter !== undefined, "");
		return this._counter.value;
	}

	increment(incrementAmount: number): void {
		assert(this._counter !== undefined, "");
		return this._counter.increment(incrementAmount);
	}

	public async initializingFirstTime(props?: any): Promise<void> {
		const counter = SharedCounter.create(this.runtime, "counter");
		counter.bindToContext();
	}

	public async hasInitialized(): Promise<void> {
		this._counter = (await this.runtime.getChannel("counter")) as SharedCounter;
	}

	constructor(props: IDataObjectProps) {
		super(props);
	}
}
