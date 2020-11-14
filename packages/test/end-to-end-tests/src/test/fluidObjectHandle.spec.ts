/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import assert from "assert";
import { IFluidHandle } from "@fluidframework/core-interfaces";
import { SharedMap } from "@fluidframework/map";
import { requestFluidObject } from "@fluidframework/runtime-utils";
import {
    TestFluidObject,
} from "@fluidframework/test-utils";
import {
    generateTestWithCompat,
    ICompatLocalTestObjectProvider,
    TestDataObject,
} from "./compatUtils";

const tests = (args: ICompatLocalTestObjectProvider) => {
    let firstContainerObject1: TestDataObject;
    let firstContainerObject2: TestDataObject;
    let secondContainerObject1: TestDataObject;

    beforeEach(async () => {
        // Create a Container for the first client.
        const firstContainer = await args.makeTestContainer();
        firstContainerObject1 = await requestFluidObject<TestDataObject>(firstContainer, "default");
        const containerRuntime1 = firstContainerObject1._context.containerRuntime;
        const dataStore = await containerRuntime1.createDataStore(TestDataObject.type);
        firstContainerObject2 = await requestFluidObject<TestDataObject>(dataStore, "");

        // Load the Container that was created by the first client.
        const secondContainer = await args.loadTestContainer();
        secondContainerObject1 = await requestFluidObject<TestDataObject>(secondContainer, "default");

        await args.opProcessingController.process();
    });

    it("can store and retrieve a DDS from handle within same data store runtime", async () => {
        // Create a new SharedMap in `firstContainerObject1` and set a value.
        const sharedMap = SharedMap.create(firstContainerObject1._runtime);
        sharedMap.set("key1", "value1");

        const sharedMapHandle = sharedMap.handle;

        // The expected absolute path.
        const absolutePath = `/default/${sharedMap.id}`;

        // Verify that the local client's handle has the correct absolute path.
        assert.equal(sharedMapHandle.absolutePath, absolutePath, "The handle's path is incorrect");

        // Add the handle to the root DDS of `firstContainerObject1`.
        firstContainerObject1._root.set("sharedMap", sharedMapHandle);

        await args.opProcessingController.process();

        // Get the handle in the remote client.
        const remoteSharedMapHandle = secondContainerObject1._root.get<IFluidHandle<SharedMap>>("sharedMap");

        // Verify that the remote client's handle has the correct absolute path.
        assert.equal(remoteSharedMapHandle.absolutePath, absolutePath, "The remote handle's path is incorrect");

        // Get the SharedMap from the handle.
        const remoteSharedMap = await remoteSharedMapHandle.get();
        // Verify that it has the value that was set in the local client.
        assert.equal(remoteSharedMap.get("key1"), "value1", "The map does not have the value that was set");
    });

    it("can store and retrieve a DDS from handle in different data store runtime", async () => {
        // Create a new SharedMap in `firstContainerObject2` and set a value.
        const sharedMap = SharedMap.create(firstContainerObject2._runtime);
        sharedMap.set("key1", "value1");

        const sharedMapHandle = sharedMap.handle;

        // The expected absolute path.
        const absolutePath = `/${firstContainerObject2._runtime.id}/${sharedMap.id}`;

        // Verify that the local client's handle has the correct absolute path.
        assert.equal(sharedMapHandle.absolutePath, absolutePath, "The handle's path is incorrect");

        // Add the handle to the root DDS of `firstContainerObject1` so that the FluidDataObjectRuntime is different.
        firstContainerObject1._root.set("sharedMap", sharedMap.handle);

        await args.opProcessingController.process();

        // Get the handle in the remote client.
        const remoteSharedMapHandle = secondContainerObject1._root.get<IFluidHandle<SharedMap>>("sharedMap");

        // Verify that the remote client's handle has the correct absolute path.
        assert.equal(remoteSharedMapHandle.absolutePath, absolutePath, "The remote handle's path is incorrect");

        // Get the SharedMap from the handle.
        const remoteSharedMap = await remoteSharedMapHandle.get();
        // Verify that it has the value that was set in the local client.
        assert.equal(remoteSharedMap.get("key1"), "value1", "The map does not have the value that was set");
    });

    it("can store and retrieve a PureDataObject from handle in different data store runtime", async () => {
        // The expected absolute path.
        const absolutePath = `/${firstContainerObject2._runtime.id}`;

        const dataObjectHandle = firstContainerObject2.handle;

        // Verify that the local client's handle has the correct absolute path.
        assert.equal(dataObjectHandle.absolutePath, absolutePath, "The handle's absolutepath is not correct");

        // Add `firstContainerObject2's` handle to the root DDS of `firstContainerObject1` so that the
        // FluidDataObjectRuntime is different.
        firstContainerObject1._root.set("dataObject2", firstContainerObject2.handle);

        await args.opProcessingController.process();

        // Get the handle in the remote client.
        const remoteDataObjectHandle =
            secondContainerObject1._root.get<IFluidHandle<TestFluidObject>>("dataObject2");

        // Verify that the remote client's handle has the correct absolute path.
        assert.equal(remoteDataObjectHandle.absolutePath, absolutePath, "The remote handle's path is incorrect");

        // Get the dataObject from the handle.
        const container2DataObject2 = await remoteDataObjectHandle.get();
        // Verify that the `url` matches with that of the dataObject in container1.
        assert.equal(
            container2DataObject2.handle.absolutePath,
            firstContainerObject2.handle.absolutePath,
            "The urls do not match");
    });
};

describe("FluidObjectHandle", () => {
    generateTestWithCompat(tests);
});
