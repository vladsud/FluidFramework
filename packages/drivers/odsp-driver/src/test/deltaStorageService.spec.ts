/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import type { ITelemetryBaseLogger } from "@fluidframework/core-interfaces";
import {
	IDeltasFetchResult,
	ISequencedDocumentMessage,
} from "@fluidframework/driver-definitions/internal";
import { ParallelRequests } from "@fluidframework/driver-utils/internal";
import {
	IFileEntry,
	IOdspResolvedUrl,
} from "@fluidframework/odsp-driver-definitions/internal";
import { ITelemetryLoggerExt, MockLogger } from "@fluidframework/telemetry-utils/internal";

import {
	ISequencedDeltaOpMessage,
	IDeltaStorageGetResponse1,
	IDeltaStorageGetResponse2,
} from "../contracts.js";
import { EpochTracker } from "../epochTracker.js";
import { LocalPersistentCache } from "../odspCache.js";
import {
	OdspDeltaStorageService,
	OdspDeltaStorageWithCache,
} from "../odspDeltaStorageService.js";
import { OdspDocumentStorageService } from "../odspDocumentStorageManager.js";

import { mockFetchOk, mockFetchMultiple, okResponse } from "./mockFetch.js";

const createUtLocalCache = (): LocalPersistentCache => new LocalPersistentCache(2000);
const createUtEpochTracker = (
	fileEntry: IFileEntry,
	logger: ITelemetryBaseLogger,
): EpochTracker =>
	new EpochTracker(createUtLocalCache(), fileEntry, logger as ITelemetryLoggerExt);

describe("DeltaStorageService", () => {
	/*
	 * Use fake urls so we don't accidental make real calls that make our tests flakey.
	 * Using microsoft.com as the domain so we don't send traffic somewhere hostile on accident.
	 */
	const deltaStorageBasePath = "https://fake.microsoft.com";
	const deltaStorageRelativePath = "/drives/testdrive/items/testitem/opStream";
	const testDeltaStorageUrl = `${deltaStorageBasePath}${deltaStorageRelativePath}`;
	const siteUrl = "https://fake.microsoft.com";
	const driveId = "testdrive";
	const itemId = "testitem";
	const resolvedUrl = {
		siteUrl,
		driveId,
		itemId,
		odspResolvedUrl: true,
	} as unknown as IOdspResolvedUrl;
	const fileEntry = { docId: "docId", resolvedUrl };

	it("Should build the correct sharepoint delta url with auth", async () => {
		const logger = new MockLogger();
		const deltaStorageService = new OdspDeltaStorageService(
			testDeltaStorageUrl,
			async (_refresh) => "?access_token=123",
			createUtEpochTracker(fileEntry, logger),
			logger.toTelemetryLogger(),
		);
		const actualDeltaUrl = deltaStorageService.buildUrl(3, 8);
		const expectedDeltaUrl = `${deltaStorageBasePath}/drives/testdrive/items/testitem/opStream?ump=1&filter=sequenceNumber%20ge%203%20and%20sequenceNumber%20le%207`;
		assert.equal(actualDeltaUrl, expectedDeltaUrl, "The constructed delta url is invalid");
		logger.assertMatchNone([{ category: "error" }]);
	});

	describe("Get Returns Response With Op Envelope", () => {
		const expectedDeltaFeedResponse: IDeltaStorageGetResponse1 = {
			"@odata.context": "some context",
			value: [
				{
					op: {
						type: "op",
						clientId: "present-place",
						clientSequenceNumber: 71,
						contents: null,
						minimumSequenceNumber: 1,
						referenceSequenceNumber: 1,
						sequenceNumber: 1,
						timestamp: 1,
					},
					sequenceNumber: 1,
				},
				{
					op: {
						clientId: "present-place",
						clientSequenceNumber: 71,
						contents: null,
						minimumSequenceNumber: 1,
						referenceSequenceNumber: 1,
						sequenceNumber: 2,
						type: "noop",
						timestamp: 1,
					},
					sequenceNumber: 2,
				},
			],
		};

		let deltaStorageService: OdspDeltaStorageService;
		const logger = new MockLogger();
		before(() => {
			deltaStorageService = new OdspDeltaStorageService(
				testDeltaStorageUrl,
				async (_refresh) => "",
				createUtEpochTracker(fileEntry, logger),
				logger.toTelemetryLogger(),
			);
		});
		afterEach(() => {
			logger.assertMatchNone([{ category: "error" }]);
		});

		it("Should deserialize the delta feed response correctly", async () => {
			const { messages, partialResult } = await mockFetchOk(
				async () => deltaStorageService.get(1, 8, {}),
				expectedDeltaFeedResponse,
			);
			assert(!partialResult, "partialResult === false");
			assert.equal(messages.length, 2, "Deserialized feed response is not of expected length");
			assert.equal(
				messages[0].sequenceNumber,
				1,
				"First element of feed response has invalid sequence number",
			);
			assert.equal(
				messages[1].sequenceNumber,
				2,
				"Second element of feed response has invalid sequence number",
			);
			assert.equal(
				messages[1].type,
				"noop",
				"Second element of feed response has invalid op type",
			);
		});

		it("Returning earlier ops not allowed", async () => {
			await assert.rejects(async () =>
				mockFetchOk(async () => deltaStorageService.get(2, 8, {}), expectedDeltaFeedResponse),
			);
		});

		it("Partial response new format", async () => {
			const expectedDeltaFeedResponsePartial: IDeltaStorageGetResponse2 = {
				ops: expectedDeltaFeedResponse.value.map((op) => op.op),
				latestSequenceNumber: 100,
				latestSnapshotSequenceNumber: 0,
			};

			const { messages, partialResult } = await mockFetchOk(
				async () => deltaStorageService.get(1, 8, {}),
				expectedDeltaFeedResponsePartial,
			);
			assert(partialResult, "partialResult === true");
			assert.equal(messages.length, 2, "Deserialized feed response is not of expected length");
			assert.equal(
				messages[0].sequenceNumber,
				1,
				"First element of feed response has invalid sequence number",
			);
			assert.equal(
				messages[1].sequenceNumber,
				2,
				"Second element of feed response has invalid sequence number",
			);
			assert.equal(
				messages[1].type,
				"noop",
				"Second element of feed response has invalid op type",
			);
		});

		it("Empty response", async () => {
			const { messages, partialResult } = await mockFetchOk(
				async () => deltaStorageService.get(1, 8, {}),
				{
					...expectedDeltaFeedResponse,
					value: [],
				},
			);
			assert(!partialResult, "partialResult === false");
			assert.equal(messages.length, 0, "Deserialized feed response is not of expected length");
		});

		it("Empty partial response not allowed (new format)", async () => {
			const expectedDeltaFeedResponseEmptyPartial: IDeltaStorageGetResponse2 = {
				ops: [],
				latestSequenceNumber: 100,
				latestSnapshotSequenceNumber: 0,
			};

			await assert.rejects(
				mockFetchOk(
					async () => deltaStorageService.get(1, 8, {}),
					expectedDeltaFeedResponseEmptyPartial,
				),
			);
		});

		it("Empty response with new format", async () => {
			const expectedDeltaFeedResponseEmpty: IDeltaStorageGetResponse2 = {
				ops: [],
				latestSequenceNumber: 1,
				latestSnapshotSequenceNumber: 0,
			};

			const { messages, partialResult } = await mockFetchOk(
				async () => deltaStorageService.get(2, 8, {}),
				expectedDeltaFeedResponseEmpty,
			);

			assert(!partialResult, "partialResult === false");
			assert.equal(messages.length, 0, "Deserialized feed response is not of expected length");
		});

		it("Empty response with new format #2", async () => {
			const expectedDeltaFeedResponseEmpty: IDeltaStorageGetResponse2 = {
				ops: [],
				latestSequenceNumber: 2,
				latestSnapshotSequenceNumber: 0,
			};

			// should fail because no ops are retured, even though storage tells us there are some ops (op#1)
			await assert.rejects(
				mockFetchOk(
					async () => deltaStorageService.get(1, 8, {}),
					expectedDeltaFeedResponseEmpty,
				),
			);
		});
	});

	describe("DeltaStorageServiceWith Cache Tests", () => {
		const logger = new MockLogger();
		afterEach(() => {
			logger.assertMatchNone([{ category: "error" }]);
		});

		it("FirstCacheMiss should update to first miss op seq number correctly", async () => {
			const deltasFetchResult: IDeltasFetchResult = { messages: [], partialResult: false };
			let count = 0;
			const getCached = async (
				from: number,
				to: number,
			): Promise<ISequencedDocumentMessage[]> => {
				if (count === 0) {
					count += 1;
					return [
						{
							clientId: "present-place",
							clientSequenceNumber: 71,
							contents: null,
							minimumSequenceNumber: 1,
							referenceSequenceNumber: 1,
							sequenceNumber: from,
							type: "dds",
							timestamp: Date.now(),
						},
					];
				}
				count += 1;
				assert.fail("Should not reach here");
			};
			const odspDeltaStorageServiceWithCache = new OdspDeltaStorageWithCache(
				[],
				logger.toTelemetryLogger(),
				1000,
				1,
				async (from, to, props, reason) => deltasFetchResult,
				async (from, to) => getCached(from, to),
				(from, to) => [],
				(ops) => {},
				() =>
					({
						isFirstSnapshotFromNetwork: false,
					}) as unknown as OdspDocumentStorageService,
			);

			const messages = odspDeltaStorageServiceWithCache.fetchMessages(1, undefined);
			const batch1 = await messages.read();
			const batch2 = await messages.read();
			assert(count === 1, "There should be only 1 cache access");
			assert(batch1.done === false, "Firt batch should have returned 1 op");
			assert(batch2.done === true, "No ops should be present in second batch");
		});
	});

	describe("ParallelRequests", () => {
		async function testCore(
			payloadSize: number,
			from: number,
			to: number,
			knownTo: boolean,
		): Promise<void> {
			let nextElement = from;
			let requests = 0;
			let dispatches = 0;
			let lastSeq: number | undefined;

			const manager = new ParallelRequests<ISequencedDocumentMessage>(
				from,
				knownTo ? to : undefined,
				payloadSize,
				logger.toTelemetryLogger(),
				async (request: number, _from: number, _to: number) => {
					requests++;
					const resp = await deltaStorageService.get(_from, _to, {});
					const len = resp.messages.length;
					if (len > 0) {
						lastSeq = resp.messages[len - 1].sequenceNumber;
						assert(resp.messages[0].sequenceNumber === _from);
					}
					return { partial: resp.partialResult, cancel: false, payload: resp.messages };
				},
				(deltas: ISequencedDocumentMessage[]) => {
					dispatches++;
					for (const el of deltas) {
						assert(el.sequenceNumber === nextElement);
						nextElement++;
						assert(nextElement <= to);
					}
				},
			);

			await manager.run(1); // concurrency
			assert(nextElement <= to);
			assert(!knownTo || nextElement === to);
			if (lastSeq !== undefined) {
				assert(lastSeq === nextElement - 1);
			}
			logger.assertMatchNone([{ category: "error" }]);
		}

		function getOps(
			from: number,
			to: number,
			lastSeq?: number,
		): IDeltaStorageGetResponse1 | IDeltaStorageGetResponse2 {
			const ops: ISequencedDeltaOpMessage[] = [];

			for (let seq = from; seq < to; seq++) {
				ops.push({
					sequenceNumber: seq,
					op: {
						type: "op",
						clientId: "present-place",
						clientSequenceNumber: 71,
						contents: null,
						minimumSequenceNumber: 1,
						referenceSequenceNumber: 1,
						sequenceNumber: seq,
						timestamp: 1,
					},
				});
			}

			if (lastSeq !== undefined) {
				return {
					ops: ops.map((op) => op.op),
					latestSequenceNumber: lastSeq,
					latestSnapshotSequenceNumber: 0,
				};
			}
			return {
				"@odata.context": "some context",
				value: ops,
			};
		}

		function getResponse(from: number, to: number, lastSeq?: number) {
			return async () => okResponse({}, getOps(from, to, lastSeq));
		}

		let deltaStorageService: OdspDeltaStorageService;
		const logger = new MockLogger();
		before(() => {
			deltaStorageService = new OdspDeltaStorageService(
				testDeltaStorageUrl,
				async (_refresh) => "",
				createUtEpochTracker(fileEntry, logger),
				logger.toTelemetryLogger(),
			);
		});
		afterEach(() => {
			logger.assertMatchNone([{ category: "error" }]);
		});

		it("Filling gaps with: 2 requests", async () => {
			await mockFetchMultiple(
				async () => testCore(5000, 1, 8, true),
				[getResponse(1, 2), getResponse(2, 8)],
			);
		});

		it("Filling gaps: 2 requests in new format", async () => {
			await mockFetchMultiple(
				async () => testCore(5000, 1, 8, true),
				[getResponse(1, 2, 10000), getResponse(2, 8, 10000)],
			);
		});

		it("Filling gaps: full chunk", async () => {
			await mockFetchMultiple(
				async () => testCore(5000, 1, 5001, true),
				[getResponse(1, 5001)],
			);
		});

		it("Filling gaps: full chunk in new format", async () => {
			await mockFetchMultiple(
				async () => testCore(5000, 1, 5001, true),
				[getResponse(1, 5001, 10000)],
			);
		});

		it("Fetching tail", async () => {
			await mockFetchMultiple(
				async () => testCore(5000, 1, 5001, false),
				[getResponse(1, 100)],
			);
		});

		it("Fetching tail new format", async () => {
			await mockFetchMultiple(
				async () => testCore(5000, 1, 5001, false),
				[getResponse(1, 100, 500), getResponse(100, 501, 500)],
			);
		});

		// FAILING
		it("Fetching tail at the boundary new format", async () => {
			await mockFetchMultiple(
				async () => testCore(5000, 1, 5001, false),
				[getResponse(1, 5001, 5000)],
			);
		});

		it("Fetching long tail", async () => {
			await mockFetchMultiple(
				async () => testCore(5000, 1, 8000, false),
				[getResponse(1, 5001), getResponse(5001, 8000)],
			);
		});

		it("Fetching long tail new format", async () => {
			await mockFetchMultiple(
				async () => testCore(5000, 1, 8001, false),
				[getResponse(1, 5001, 7000), getResponse(5001, 8001, 8000)],
			);
		});
	});
});
