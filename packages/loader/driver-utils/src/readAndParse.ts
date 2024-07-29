/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert } from "@fluidframework/core-utils/internal";
import { ISnapshot, ISnapshotTree } from "@fluidframework/driver-definitions/internal";
import { bufferToString } from "@fluid-internal/client-utils";
import { IDocumentStorageService } from "@fluidframework/driver-definitions/internal";
import { isInstanceOfISnapshot } from "./storageUtils.js";

/**
 * Read a blob from {@link @fluidframework/driver-definitions#IDocumentStorageService} and
 * {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/parse | JSON.parse}
 * it into object of type `T`.
 *
 * @param storage - The `DocumentStorageService` to read from.
 * @param id - The ID of the blob to read and parse.
 *
 * @typeParam T - Output type matching JSON format of inpyt blob data.
 *
 * @returns The object that we decoded and parsed via `JSON.parse`.
 * @internal
 */
export async function readAndParse<T>(
	storage: Pick<IDocumentStorageService, "readBlob">,
	id: string,
): Promise<T> {
	const blob = await storage.readBlob(id);
	const decoded = bufferToString(blob, "utf8");
	return JSON.parse(decoded) as T;
}

/**
 * Read a blob from {@link @fluidframework/driver-definitions#IDocumentStorageService} and
 * {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/parse | JSON.parse}
 * it into object of type `T`.
 *
 * @param leafName - Name of the blob node in snapshot.
 * @param snapshot - Snapshot.
 * @param storage - The `DocumentStorageService` to read from.
 *
 * @returns The object that we decoded and parsed via `JSON.parse`.
 * @internal
 */
export async function readAndParse2(
	leafName: string,
	snapshot: ISnapshotTree | ISnapshot,
	storage: Pick<IDocumentStorageService, "readBlob">): Promise<unknown> {
	if (isInstanceOfISnapshot(snapshot)) {
		const blobId = snapshot.snapshotTree.blobs[leafName];
		assert(blobId !== undefined, "blobId not found");
		const content = snapshot.blobContents.get(blobId);
		assert(content !== undefined, "blob not found");
		return JSON.parse(bufferToString(content, "utf8"));
	} else {
		const blobId = snapshot.blobs[leafName];
		assert(blobId !== undefined, "blobId not found");
		return readAndParse<unknown>(
			storage,
			blobId,
		);
	}
}
