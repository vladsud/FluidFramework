/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert } from "@fluidframework/core-utils";
import { SharedCounter } from "@fluidframework/counter";
import { type IFluidDataStoreRuntime } from "@fluidframework/datastore-definitions";
import { DataObject, DataObjectFactory, IDataObjectProps } from "@fluidframework/aqueduct";
import {
	IFluidDataStoreContext,
	IFluidDataStoreChannel,
} from "@fluidframework/runtime-definitions";

import { ICollabChannel, ICollabChannelFactory } from "../contracts";

export interface ISharedCounter extends ICollabChannel {
	value: number;
	readonly ICollabChannel: ICollabChannel;
	increment(incrementAmount: number): void;
	// isAttached(): boolean;
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
		// const entry = await channel.entryPoint.get() as TestDataObject;

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
		const counter = new SharedCounter(
			"counter",
			this.runtime,
			SharedCounter.getFactory().attributes,
		);
		counter.initializeLocal();
		this.runtime.addChannel(counter);
		counter.bindToContext();
	}

	public async hasInitialized(): Promise<void> {
		this._counter = (await this.runtime.getChannel("counter")) as SharedCounter;
	}

	public sendSomeOp() {
		assert(this._counter !== undefined, "no cunter");
		this._counter.increment(1);
	}

	constructor(props: IDataObjectProps) {
		super(props);
	}
}
