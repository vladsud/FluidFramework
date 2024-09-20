/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { ITelemetryBaseProperties } from "@fluidframework/core-interfaces";
import { assert } from "@fluidframework/core-utils/internal";
import { validateMessages } from "@fluidframework/driver-base/internal";
import {
	IDeltasFetchResult,
	IDocumentDeltaStorageService,
	type IStream,
	ISequencedDocumentMessage,
} from "@fluidframework/driver-definitions/internal";
import { requestOps, streamObserver } from "@fluidframework/driver-utils/internal";
import { InstrumentedStorageTokenFetcher } from "@fluidframework/odsp-driver-definitions/internal";
import {
	ITelemetryLoggerExt,
	PerformanceEvent,
} from "@fluidframework/telemetry-utils/internal";
import { v4 as uuid } from "uuid";

import { IDeltaStorageGetResponse, ISequencedDeltaOpMessage } from "./contracts.js";
import { EpochTracker } from "./epochTracker.js";
import { OdspDocumentStorageService } from "./odspDocumentStorageManager.js";
import { getWithRetryForTokenRefresh } from "./odspUtils.js";

/**
 * Provides access to the underlying delta storage on the server for sharepoint driver.
 */
export class OdspDeltaStorageService {
	constructor(
		private readonly deltaFeedUrl: string,
		private readonly getAuthHeader: InstrumentedStorageTokenFetcher,
		private readonly epochTracker: EpochTracker,
		private readonly logger: ITelemetryLoggerExt,
	) {}

	/**
	 * Retrieves ops from storage
	 * @param from - inclusive
	 * @param to - exclusive
	 * @param telemetryProps - properties to add when issuing telemetry events
	 * @param scenarioName - reason for fetching ops
	 * @returns ops retrieved & info if result was partial (i.e. more is available)
	 */
	public async get(
		from: number, // inclusive
		to: number, // exclusive
		telemetryProps: ITelemetryBaseProperties,
		scenarioName?: string,
	): Promise<IDeltasFetchResult> {
		assert(from < to, "bounds check");

		return getWithRetryForTokenRefresh(async (options) => {
			// Note - this call ends up in getSocketStorageDiscovery() and can refresh token
			// Thus it needs to be done before we call getAuthHeader() to reduce extra calls
			const url = this.buildUrl(from, to);
			const method = "POST";
			const authHeader = await this.getAuthHeader(
				{ ...options, request: { url, method } },
				"DeltaStorage",
			);

			return PerformanceEvent.timedExecAsync(
				this.logger,
				{
					eventName: "OpsFetch",
					attempts: options.refresh ? 2 : 1,
					from,
					to,
					...telemetryProps,
					reason: scenarioName,
				},
				async (event) => {
					const formBoundary = uuid();
					let postBody = `--${formBoundary}\r\n`;
					postBody += `Authorization: ${authHeader}\r\n`;
					postBody += `X-HTTP-Method-Override: GET\r\n`;
					postBody += `_post: 1\r\n`;
					// A hint to service that client can accept a "null" op as an indication of how many ops there are.
					postBody += `X-FluidNullOp: true\r\n`;
					postBody += `\r\n--${formBoundary}--`;
					const headers: { [index: string]: string } = {
						"Content-Type": `multipart/form-data;boundary=${formBoundary}`,
					};

					// Some request take a long time (1-2 minutes) to complete, where telemetry shows very small amount
					// of time spent on server, and usually small payload sizes. I.e. all the time is spent somewhere in
					// networking. Even bigger problem - a lot of requests timeout (based on cursory look - after 1-2 minutes)
					// So adding some timeout to ensure we retry again in hope of faster success.
					// Please see https://github.com/microsoft/FluidFramework/issues/6997 for details.
					const abort = new AbortController();
					const timer = setTimeout(() => abort.abort(), 30000);

					const response =
						await this.epochTracker.fetchAndParseAsJSON<IDeltaStorageGetResponse>(
							url,
							{
								headers,
								body: postBody,
								method,
								signal: abort.signal,
							},
							"ops",
							true,
							scenarioName,
						);
					clearTimeout(timer);
					const deltaStorageResponse = response.content;

					let lastSequenceNumber: number | undefined;

					// This accounts for possible null ops
					const responseLength = deltaStorageResponse.value.length;
					// could be undefined if responseLength === undefined!
					const possiblyNullOp = deltaStorageResponse.value[responseLength - 1];
					if (
						possiblyNullOp !== undefined &&
						"op" in possiblyNullOp &&
						possiblyNullOp.op === null
					) {
						// it's 1 over last known sequence number to storage
						lastSequenceNumber = possiblyNullOp.sequenceNumber - 1;
						// remove the last item
						deltaStorageResponse.value.pop();
					}

					// Actual number of ops with content
					const length = deltaStorageResponse.value.length;

					const messages =
						length > 0 && "op" in deltaStorageResponse.value[0]
							? (deltaStorageResponse.value as ISequencedDeltaOpMessage[]).map((operation) => {
									assert(operation.op !== null, "null can be only last entry");
									return operation.op;
								})
							: (deltaStorageResponse.value as ISequencedDocumentMessage[]);

					// validate integrity of the response
					let seq = from;
					for (const op of messages) {
						assert(seq === op.sequenceNumber, "seq#");
						seq++;
					}

					event.end({
						length,
						...response.propsToLog,
					});

					// The protocol was - if the service returns less ops than what client asked, then that's all service has.
					// However due to some incidents, service made a recent change to return less content to the client if payload is too large.
					// Once we have lastSequenceNumber, we will know for sure if fewer ops returned means - EOF or throttling.
					// If client tries to fill in ops gap, then it knows how many ops it needs and it  does not matter what the value of
					// `partialResult` - if there are not enough ops, client will ask for more (in a loop), even if service has no more ops.
					// It matters only when client does not know much about how long the tail is.
					// While it's not correct in presence of service throttling, we will continue to assume (no change in behavior from the past) that
					// - if fewer ops are returned, that's all service has
					// - if request is fully satisfied, there are probably more ops out there.
					let partialResult = seq === to;

					if (lastSequenceNumber !== undefined) {
						if (length === 0) {
							assert(lastSequenceNumber < from, "empty partial results are not allowed");
							assert(!partialResult, "not allowed");
						} else {
							partialResult = lastSequenceNumber > messages[length - 1].sequenceNumber;
						}
					}

					// It is assumed that server always returns all the ops that it has in the range that was requested.
					// This may change in the future, if so, we need to adjust and receive "end" value from server in such case.
					return { messages, partialResult };
				},
			);
		});
	}

	public buildUrl(from: number, to: number): string {
		const filter = encodeURIComponent(
			`sequenceNumber ge ${from} and sequenceNumber le ${to - 1}`,
		);
		const queryString = `?ump=1&filter=${filter}`;
		return `${this.deltaFeedUrl}${queryString}`;
	}
}

export class OdspDeltaStorageWithCache implements IDocumentDeltaStorageService {
	private useCacheForOps = true;

	public constructor(
		private snapshotOps: ISequencedDocumentMessage[] | undefined,
		private readonly logger: ITelemetryLoggerExt,
		private readonly batchSize: number,
		private readonly concurrency: number,
		private readonly getFromStorage: (
			from: number,
			to: number,
			telemetryProps: ITelemetryBaseProperties,
			fetchReason?: string,
		) => Promise<IDeltasFetchResult>,
		private readonly getCached: (
			from: number,
			to: number,
		) => Promise<ISequencedDocumentMessage[]>,
		private readonly requestFromSocket: (from: number, to: number) => void,
		private readonly opsReceived: (ops: ISequencedDocumentMessage[]) => void,
		private readonly storageManagerGetter: () => OdspDocumentStorageService | undefined,
	) {}

	public fetchMessages(
		fromTotal: number,
		toTotal: number | undefined,
		abortSignal?: AbortSignal,
		cachedOnly?: boolean,
		fetchReason?: string,
	): IStream<ISequencedDocumentMessage[]> {
		// We do not control what's in the cache. Current API assumes that fetchMessages() keeps banging on
		// storage / cache until it gets ops it needs. This would result in deadlock if fixed range is asked from
		// cache and it's not there.
		// Better implementation would be to return only what we have in cache, but that also breaks API
		assert(!cachedOnly || toTotal === undefined, 0x1e3);

		// Don't use cache for ops is snapshot is fetched from network or if it was not fetched at all.
		this.useCacheForOps =
			this.useCacheForOps && this.storageManagerGetter()?.isFirstSnapshotFromNetwork === false;
		let opsFromSnapshot = 0;
		let opsFromCache = 0;
		let opsFromStorage = 0;

		const requestCallback = async (
			from: number,
			to: number,
			telemetryProps: ITelemetryBaseProperties,
		): Promise<IDeltasFetchResult> => {
			if (this.snapshotOps !== undefined && this.snapshotOps.length > 0) {
				const messages = this.snapshotOps.filter(
					(op) => op.sequenceNumber >= from && op.sequenceNumber < to,
				);
				validateMessages("cached", messages, from, this.logger);
				if (messages.length > 0 && messages[0].sequenceNumber === from) {
					this.snapshotOps = this.snapshotOps.filter((op) => op.sequenceNumber >= to);
					opsFromSnapshot += messages.length;
					return { messages, partialResult: true };
				}
				this.snapshotOps = undefined;
			}

			// Kick out request to PUSH for ops if it has them
			this.requestFromSocket(from, to);

			// Cache in normal flow is continuous. Once there is a miss, stop consulting cache.
			// This saves a bit of processing time.
			if (this.useCacheForOps) {
				const messagesFromCache = await this.getCached(from, to);
				validateMessages("cached", messagesFromCache, from, this.logger);
				// Set the firstCacheMiss as true in case we didn't get all the ops.
				// This will save an extra cache read on "DocumentOpen" or "PostDocumentOpen".
				this.useCacheForOps = from + messagesFromCache.length >= to;
				if (messagesFromCache.length > 0) {
					opsFromCache += messagesFromCache.length;
					return {
						messages: messagesFromCache,
						partialResult: true,
					};
				}
			}

			if (cachedOnly) {
				return { messages: [], partialResult: false };
			}

			const ops = await this.getFromStorage(from, to, telemetryProps, fetchReason);
			validateMessages("storage", ops.messages, from, this.logger);
			opsFromStorage += ops.messages.length;
			this.opsReceived(ops.messages);
			return ops;
		};

		const stream = requestOps(
			async (from: number, to: number, telemetryProps: ITelemetryBaseProperties) => {
				const result = await requestCallback(from, to, telemetryProps);
				// Catch all case, just in case
				validateMessages("catch all", result.messages, from, this.logger);
				return result;
			},
			// Staging: starting with no concurrency, listening for feedback first.
			// In future releases we will switch to actual concurrency
			this.concurrency,
			fromTotal, // inclusive
			toTotal, // exclusive
			this.batchSize,
			this.logger,
			abortSignal,
			fetchReason,
		);

		return streamObserver(stream, (result) => {
			if (result.done && opsFromSnapshot + opsFromCache + opsFromStorage !== 0) {
				this.logger.sendPerformanceEvent({
					eventName: "CacheOpsRetrieved",
					opsFromSnapshot,
					opsFromCache,
					opsFromStorage,
					reason: fetchReason,
				});
			}
		});
	}
}
