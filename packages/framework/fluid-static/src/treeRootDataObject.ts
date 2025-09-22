/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
	BaseContainerRuntimeFactory,
	TreeDataObject,
	TreeDataObjectFactory,
	type DataObjectTypes,
} from "@fluidframework/aqueduct/internal";
import type { IDataObjectProps } from "@fluidframework/aqueduct/internal";
import type { IRuntimeFactory } from "@fluidframework/container-definitions/internal";
import {
	type IContainerRuntimeOptions,
	type MinimumVersionForCollab,
} from "@fluidframework/container-runtime/internal";
import type {
	IContainerRuntime,
	IContainerRuntimeInternal,
} from "@fluidframework/container-runtime-definitions/internal";
import type {
	FluidObject,
	IFluidHandle,
	IFluidLoadable,
} from "@fluidframework/core-interfaces";
import { assert } from "@fluidframework/core-utils/internal";
import type { IChannelFactory } from "@fluidframework/datastore-definitions/internal";
import type { NamedFluidDataStoreRegistryEntries } from "@fluidframework/runtime-definitions/internal";
import type { SharedObjectKind } from "@fluidframework/shared-object-base/internal";

import { compatibilityModeRuntimeOptions } from "./compatibilityConfiguration.js";
import type {
	CompatibilityMode,
	IRootDataObject,
	IStaticEntryPoint,
	LoadableObjectKind,
	LoadableObjectRecord,
	TreeContainerSchema,
} from "./types.js";
import {
	compatibilityModeToMinVersionForCollab,
	createDataObject,
	createSharedObject,
	isDataObjectKind,
	isSharedObjectKind,
	makeFluidObject,
	parseDataObjectsFromSharedObjects,
} from "./utils.js";

/**
 * This module contains types and factories for creating tree-based root data objects.
 * They exist as an alternative to the APIs in `rootDataObject.ts`.
 *
 * These APIs are currently shaped to parallel `RootDataObject`, but this is not intended as the long-term design.
 * The current shape is a short-term solution to allow for easier migration from the old APIs.
 */

/**
 * The entry-point/root collaborative object of the {@link IFluidContainer | Fluid Container}.
 *
 * @remarks
 * Abstracts the dynamic code required to build a Fluid Container into a static representation for end customers.
 *
 * @legacy @beta
 */
export class TreeRootDataObject<TDataObjectTypes extends DataObjectTypes = DataObjectTypes> extends TreeDataObject<TDataObjectTypes> implements IRootDataObject {
	public constructor(props: IDataObjectProps<TDataObjectTypes>) {
		super(props);
	}

	public get TreeRootDataObject(): TreeRootDataObject {
		return this;
	}

	// TODO: longer term, it would be better to not have to fit into the `initialObjects` model for tree-based containers.
	// But in the short term, fitting into this model makes migration easier.
	public get initialObjects(): LoadableObjectRecord {
		return {
			tree: this.tree,
		};
	}

	public async create<T>(objectClass: SharedObjectKind<T>): Promise<T> {
		const internal = objectClass as unknown as LoadableObjectKind<T & IFluidLoadable>;
		if (isDataObjectKind(internal)) {
			return createDataObject(internal, this.context);
		} else if (isSharedObjectKind(internal)) {
			return createSharedObject(internal, this.runtime);
		}
		throw new Error("Could not create new Fluid object because an unknown object was passed");
	}

	public async uploadBlob(blob: ArrayBufferLike): Promise<IFluidHandle<ArrayBufferLike>> {
		return this.runtime.uploadBlob(blob);
	}
}

/**
 * Alias (name) of root data store.
 * WARNING: This string is serialized as part of file format, changing it will break existing files and processes.
 */
const treeRootDataStoreId = "treeRootDOId";

/**
 * Type of the {@link TreeRootDataObject}.
 * WARNING: This string is serialized as part of file format, changing it will break existing files and processes.
 * @remarks Used in the PureDataObjectFactory to create the root data object.
 */
const treeRootDataObjectType = "treeRootDO";

async function provideEntryPoint(
	containerRuntime: IContainerRuntime,
): Promise<IStaticEntryPoint> {
	const entryPoint = await containerRuntime.getAliasedDataStoreEntryPoint(treeRootDataStoreId);
	if (entryPoint === undefined) {
		throw new Error(`default dataStore [${treeRootDataStoreId}] must exist`);
	}
	const treeRootDataObject = ((await entryPoint.get()) as FluidObject<TreeRootDataObject>)
		.TreeRootDataObject;
	assert(
		treeRootDataObject !== undefined,
		0xbe7 /* entryPoint must be of type TreeRootDataObject */,
	);
	return makeFluidObject<IStaticEntryPoint>(
		{
			rootDataObject: treeRootDataObject,
			extensionStore: containerRuntime as IContainerRuntimeInternal,
		},
		"IStaticEntryPoint",
	);
}

/**
 * Factory for Container Runtime instances that provide a {@link IStaticEntryPoint}
 * (containing single {@link IRootDataObject}) as their entry point.
 */
class TreeContainerRuntimeFactory extends BaseContainerRuntimeFactory {
	// TODO: use for runtime factory.
	readonly #treeRootDataObjectFactory: TreeDataObjectFactory<TreeRootDataObject>;

	public constructor(
		compatibilityMode: CompatibilityMode,
		treeRootDataObjectFactory: TreeDataObjectFactory<TreeRootDataObject>,
		overrides?: Partial<{
			runtimeOptions: Partial<IContainerRuntimeOptions>;
			minVersionForCollab: MinimumVersionForCollab;
		}>,
	) {
		super({
			registryEntries: [treeRootDataObjectFactory.registryEntry],
			runtimeOptions: {
				...compatibilityModeRuntimeOptions[compatibilityMode],
				...overrides?.runtimeOptions,
			},
			provideEntryPoint,
			minVersionForCollab:
				overrides?.minVersionForCollab ??
				compatibilityModeToMinVersionForCollab[compatibilityMode],
		});
		this.#treeRootDataObjectFactory = treeRootDataObjectFactory;
	}

	protected override async containerInitializingFirstTime(runtime: IContainerRuntime): Promise<void> {
		// The first time we create the container we create the RootDataObject
		await this.#treeRootDataObjectFactory.createRootInstance(treeRootDataStoreId, runtime);
	}
}

/**
 * Factory that creates instances of a tree-based root data object.
 *
 * @legacy @beta
 */
export class TreeRootDataObjectFactory extends TreeDataObjectFactory<TreeRootDataObject> {
	public constructor(
		sharedObjects: readonly IChannelFactory[] = [],
		registryEntries: NamedFluidDataStoreRegistryEntries,
	) {
		super({
			type: treeRootDataObjectType,
			ctor: TreeRootDataObject,
			sharedObjects,
			registryEntries,
		});
	}
}

/**
 * Creates an {@link @fluidframework/aqueduct#IRuntimeFactory} which constructs containers
 * with an entry point containing single tree-based root data object.
 *
 * @remarks
 * The entry point is opaque to caller.
 * The root data object's registry and shared objects are configured based on the provided
 * SharedTree and optionally data store registry.
 *
 * @legacy @beta
 */
export function createTreeContainerRuntimeFactory(props: {
	/**
	 * The schema for the container.
	 */
	readonly schema: TreeContainerSchema;

	/**
	 * See {@link CompatibilityMode} and compatibilityModeRuntimeOptions for more details.
	 */
	readonly compatibilityMode: CompatibilityMode;
	/**
	 * Optional overrides for the container runtime options.
	 * If not provided, only the default options for the given compatibilityMode will be used.
	 */
	readonly runtimeOptionOverrides?: Partial<IContainerRuntimeOptions>;
	/**
	 * Optional override for minimum version for collab.
	 * If not provided, the default for the given compatibilityMode will be used.
	 * @remarks
	 * This is useful when runtime options are overridden and change the minimum version for collab.
	 */
	readonly minVersionForCollabOverride?: MinimumVersionForCollab;

	/*
	 Options override for a factory
	*/
	readonly rootFactory?: new (
		sharedObjects: readonly IChannelFactory[],
		registryEntries: NamedFluidDataStoreRegistryEntries,
	) => TreeRootDataObjectFactory;
}): IRuntimeFactory {
	const {
		compatibilityMode,
		minVersionForCollabOverride,
		runtimeOptionOverrides,
		schema,
		rootFactory = TreeRootDataObjectFactory,
	} = props;

	const [registryEntries, sharedObjects] = parseDataObjectsFromSharedObjects(schema);

	return new TreeContainerRuntimeFactory(
		compatibilityMode,
		new rootFactory(sharedObjects, registryEntries),
		{
			runtimeOptions: runtimeOptionOverrides,
			minVersionForCollab: minVersionForCollabOverride,
		},
	);
}
