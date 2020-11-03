/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { ContainerRuntimeFactoryWithScope } from "@fluidframework/aqueduct";
import { Spaces } from "./fluid-object/";

/**
 * This does setup for the Fluid Container.
 *
 * There are two important things here:
 * 1. Default FluidObject name
 * 2. Map of string to factory for all FluidObjects
 *
 * In this example, we are only registering a single FluidObject, but more complex examples will register multiple
 * FluidObjects.
 */

export const SpacesContainer = new ContainerRuntimeFactoryWithScope(
    Spaces.getFactory(),
    [[Spaces.ComponentName, Promise.resolve(Spaces.getFactory())]],
);
