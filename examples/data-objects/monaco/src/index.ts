/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    ContainerRuntimeFactoryWithDefaultDataStore,
    DataObjectFactory,
} from "@fluidframework/aqueduct";
import { IProvideRuntimeFactory } from "@fluidframework/container-definitions";
import { IProvideFluidDataStoreFactory } from "@fluidframework/runtime-definitions";
import * as sequence from "@fluidframework/sequence";
import { FluidDataStoreRegistry } from "@fluidframework/runtime-utils";
import { MonacoRunner } from "./chaincode";

const componentFactory = new DataObjectFactory(
    "@fluid-example/monaco",
    MonacoRunner,
    [
        sequence.SharedString.getFactory(),
        sequence.SharedObjectSequence.getFactory(),
        sequence.SharedNumberSequence.getFactory(),
    ],
    {},
);

const runtimeFactory = new ContainerRuntimeFactoryWithDefaultDataStore(
    componentFactory,
    new FluidDataStoreRegistry([
        [componentFactory.type, Promise.resolve(componentFactory)],
    ]),
);

export const fluidExport: IProvideFluidDataStoreFactory & IProvideRuntimeFactory = {
    IFluidDataStoreFactory: componentFactory,
    IRuntimeFactory: runtimeFactory,
};
