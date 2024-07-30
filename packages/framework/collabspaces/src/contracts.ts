/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
import { Serializable } from "@fluidframework/datastore-definitions/internal";
import { ISharedMatrixCore, MatrixItem } from "@fluidframework/matrix/internal";
import {
	IFluidDataStoreChannel,
	IFluidDataStoreFactory,
	IFluidDataStoreContext,
} from "@fluidframework/runtime-definitions/internal";

/**
 * Interface for internal communication
 * Additional requirements to channel over standard IChannel interface
 * @internal
 */
export interface ICollabChannel<T = unknown> {
	readonly value: Exclude<Serializable<T>, undefined>;
	readonly ICollabChannel: ICollabChannel<T>;
}

/** @internal */
export interface IInternalChannel<T extends ICollabChannel = ICollabChannel> {
	value: T;
	channel: IFluidDataStoreChannel;
	id: string;
}

/** @internal */
export function getCollabValue<T extends ICollabChannel>(
	channel: IInternalChannel<T>,
): T["value"] {
	return channel.value.value;
}

/** @internal */
export async function getCollabChannel(channel: IFluidDataStoreChannel) {
	const entry = await channel.entryPoint.get();
	return (entry as ICollabChannel).ICollabChannel;
}

/** @internal */
export interface ICollabChannelFactory extends IFluidDataStoreFactory {
	create2(
		context: IFluidDataStoreContext,
		initialValue: unknown,
	): Promise<IFluidDataStoreChannel>;
}

/** @internal */
export interface MatrixExternalType {
	value: Exclude<Serializable<unknown>, undefined>;
	type: string;
}

/** @internal */
export enum SaveResult {
	Dirty, // Channel is dirty, not saved
	NotRooted, // Channel is not rooted, not saved
	CantSave, // Can't save as need to process more ops
	NoNeedToSave, // channel is already saved, no need to save
	Saved, // channel was saved
}

/** @internal */
export type CollabSpaceCellType = MatrixItem<MatrixExternalType>;

/** @internal */
export interface IEfficientMatrix
	extends Omit<
		ISharedMatrixCore<MatrixExternalType>,
		"on" | "off" | "once" | "getCell" | "setCells"
	> {
	// Semantics of this operation differ substantially from regular matrix.
	// This will overwrite the value of the cell, thus creating a new collab channel (in the future)
	// Usually used to change cell type to a different type.
	// When such change occurs, the old channel that was associated with this cell becomes
	// non-rooted, i.e. it no longer is accosiated wit the cell. Ops might still come in for such channel
	// due to races / offline clients.
	// Old channel could come back to life (become again rooted / associated with cell) through undo!
	setCell(rowArg: number, colArg: number, value: CollabSpaceCellType);

	getCellAsync(row: number, col: number): Promise<CollabSpaceCellType>;

	// Returns collab channel that is associated with a cell. Type of the channel depeds on type of cell
	// If collab channel already exists, it is returned. Otherwise new channel is created.
	// While channel is active, it represents the truth for a cell. getCell*() API will
	// return channel value while channel exists.
	getCellChannel(row: number, col: number): Promise<IInternalChannel>;

	// Save content from channel to cell.
	// Operation could fail (return false) for multiple reasons:
	//  - if channel is detached (saves are not performed unless channel is being destroyed)
	//  - if chanel is dirty (has non-acked changes, only applicable to attached states)
	//  - if channel is no longer "rooted" in a cell.
	// Operation could fail (returns true, but save does not happen)
	//  - due to FWW merge policy used, and another client either doing save or overwriting cell.
	// This operation does not change visible characteristics of the system. It only prepares channel
	// for future possibility to be destroyed.
	saveChannelState(channel: IInternalChannel): SaveResult;

	// Experimental! It can be called only when condirions are right:
	// - data has been saved to cell in non-conflicting matter.
	//   - this means there are no channel ops in between last save's ref seq number and current point in time!
	// - no records on undo stack
	// Returns true if channel was actually destroyed.
	destroyCellChannel(channel: IInternalChannel): boolean;

	getAllChannels(): Promise<{ rooted: IInternalChannel[]; notRooted: IInternalChannel[] }>;
}

/**
 * Interface for testing purposes only.
 * @internal
 */
export interface IEfficientMatrixTest {
	isAttached: boolean;

	// Returns a structure with various debug info about the cell
	getCellDebugInfo(
		row: number,
		col: number,
	): Promise<{ channel: IInternalChannel | undefined; rowId: string; colId: string }>;

	getReverseMapsDebugInfo(): Readonly<{
		rowMap: { [id: string]: number };
		colMap: { [id: string]: number };
	}>;

	getReverseMapCellDebugInfo(
		rowId: string,
		colId: string,
	): Promise<{ row: number; col: number }>;
}
