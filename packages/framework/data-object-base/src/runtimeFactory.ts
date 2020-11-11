/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IContainerContext, IRuntime, IRuntimeFactory } from "@fluidframework/container-definitions";
import {
    ContainerRuntime,
} from "@fluidframework/container-runtime";
import {
    buildRuntimeRequestHandler,
    RuntimeRequestHandler,
    innerRequestHandler,
} from "@fluidframework/request-handler";
import {
    IFluidDataStoreFactory,
    FlushMode,
    IFluidDataStoreRegistry,
} from "@fluidframework/runtime-definitions";
import { createDataStoreRegistry } from "@fluidframework/runtime-utils";

const defaultStoreId = "" as const;

export class RuntimeFactory implements IRuntimeFactory {
    private readonly registry: IFluidDataStoreRegistry;

    constructor(
        private readonly defaultStoreFactory: IFluidDataStoreFactory,
        storeFactories: IFluidDataStoreFactory[] = [defaultStoreFactory],
        private readonly requestHandlers: RuntimeRequestHandler[] = [],
    ) {
        this.registry = createDataStoreRegistry(
            (storeFactories.includes(defaultStoreFactory)
                ? storeFactories
                : storeFactories.concat(defaultStoreFactory)
            ).map(
                (factory) => [factory.type, Promise.resolve(factory)]));
    }

    public get IRuntimeFactory() { return this; }

    public async instantiateRuntime(context: IContainerContext): Promise<IRuntime> {
        const runtime = await ContainerRuntime.load(
            context,
            this.registry,
            buildRuntimeRequestHandler(
                ...this.requestHandlers,
                innerRequestHandler),
        );

        // Flush mode to manual to batch operations within a turn
        runtime.setFlushMode(FlushMode.Manual);

        // On first boot create the base data store
        if (!runtime.existing && this.defaultStoreFactory.type) {
            await runtime.createRootDataStore(this.defaultStoreFactory.type, defaultStoreId);
        }

        return runtime;
    }
}
