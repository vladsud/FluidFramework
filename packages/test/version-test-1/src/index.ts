/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { ContainerRuntimeFactoryWithDefaultDataStore } from "@fluidframework/aqueduct";
import { createDataStoreFactory, createDataStoreRegistry } from "@fluidframework/runtime-utils";

import { VersiontestInstantiationFactory } from "./main";

const fluidPackageName = "@fluid-internal/version-test-1";

const defaultFactory = createDataStoreFactory(fluidPackageName, VersiontestInstantiationFactory);

export const fluidExport = new ContainerRuntimeFactoryWithDefaultDataStore(
    defaultFactory,
    createDataStoreRegistry([
        [defaultFactory.type, Promise.resolve(defaultFactory)],
    ]),
);
