/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";

import { unreachableCase } from "@fluidframework/core-utils/internal";
import { MockLogger } from "@fluidframework/telemetry-utils/internal";

import { ParallelRequests } from "../parallelRequests.js";

enum HowMany {
	Exact,
	Partial,
	TooMany,
}

describe("Parallel Requests", () => {
	async function testCore(
		concurrency: number,
		payloadSize: number,
		from: number,
		to: number,
		knownTo: boolean,
		responses: ((
			request: number,
			_from: number,
			_to: number,
		) => { partial: boolean; cancel: boolean; payload: number[] })[],
		dispatchesTotal?: number,
	) {
		let nextElement = from;
		let requests = 0;
		let dispatches = 0;
		let lastSeq: number | undefined;

		const logger = new MockLogger();

		const manager = new ParallelRequests<number>(
			from,
			knownTo ? to : undefined,
			payloadSize,
			logger.toTelemetryLogger(),
			async (request: number, _from: number, _to: number) => {
				const response = responses.shift();
				assert(response !== undefined, "too many requests");
				requests++;
				const resp = response(request, _from, _to);
				const len = resp.payload.length;
				if (len > 0) {
					lastSeq = resp.payload[len - 1];
					assert(resp.payload[0] === _from);
				}
				return resp;
			},
			(deltas: number[]) => {
				dispatches++;
				for (const el of deltas) {
					assert(el === nextElement);
					nextElement++;
				}
			},
		);

		await manager.run(concurrency);
		assert(nextElement <= to);
		assert(!knownTo || nextElement === to);
		assert(!knownTo || dispatches === (dispatchesTotal ?? requests));
		if (lastSeq !== undefined && concurrency === 1) {
			assert(lastSeq === nextElement - 1);
		}
		assert.equal(responses.length, 0, "expected requests");
		logger.assertMatchNone([{ category: "error" }]);
	}

	function genPayload(from: number, to: number) {
		const payload: number[] = [];
		for (let i = from; i < to; i++) {
			payload.push(i);
		}
		return payload;
	}

	async function test(
		concurrency: number,
		payloadSize: number,
		from: number,
		to: number,
		expectedRequests: number,
		knownTo: boolean,
		howMany: HowMany = HowMany.Exact,
	) {
		const response = (request: number, _from: number, _to: number) => {
			let length = _to - _from;

			assert(_from >= from);
			assert(length <= payloadSize);
			assert(!knownTo || _to <= to);

			switch (howMany) {
				case HowMany.Partial:
					length = Math.min(length, payloadSize / 2 + 1);
					break;
				case HowMany.TooMany:
					length = 2 * length + 2;
					break;
				case HowMany.Exact:
					break;
				default:
					unreachableCase(howMany);
			}
			// covering knownTo === false case
			const actualTo = Math.min(_from + length, to);

			return {
				partial: _from !== to || howMany === HowMany.Partial,
				cancel: false,
				payload: genPayload(_from, actualTo),
			};
		};

		return testCore(
			concurrency,
			payloadSize,
			from,
			to,
			knownTo,
			Array(expectedRequests).fill(response),
		);
	}

	async function testCancel(
		from: number,
		to: number | undefined,
		cancelAt: number,
		payloadSize,
		expectedRequests: number,
	) {
		let nextElement = from;
		let requests = 0;
		let dispatches = 0;
		const logger = new MockLogger();

		const manager = new ParallelRequests<number>(
			from,
			to,
			payloadSize,
			logger.toTelemetryLogger(),
			async (request: number, _from: number, _to: number) => {
				const length = _to - _from;
				requests++;

				assert(_from >= from);
				assert(length <= payloadSize);
				assert(requests <= request);
				assert(to === undefined || _to <= to);

				if (_to > cancelAt) {
					return { partial: false, cancel: true, payload: [] };
				}

				const payload: number[] = [];
				for (let i = _from; i < _to; i++) {
					payload.push(i);
				}

				return { partial: false, cancel: false, payload };
			},
			(deltas: number[]) => {
				dispatches++;
				assert(dispatches <= requests);
				for (const el of deltas) {
					assert(el === nextElement);
					nextElement++;
				}
			},
		);

		await manager.run(10);

		assert(dispatches <= requests);
		assert(requests === expectedRequests);
		logger.assertMatchNone([{ category: "error" }]);
	}

	it("no concurrency, single request, over", async () => {
		await test(1, 100, 123, 156, 1, true);
		await test(1, 100, 123, 156, 1, false);
		await test(1, 100, 123, 156, 1, true, HowMany.TooMany);
		await test(1, 100, 123, 156, 1, true, HowMany.Partial);
	});

	it("no concurrency, single request, exact", async () => {
		await test(1, 156 - 123, 123, 156, 1, true);
		await test(1, 156 - 123, 123, 156, 2, false);
		await test(1, 156 - 123, 123, 156, 1, true, HowMany.TooMany);
		await test(1, 156 - 123, 123, 156, 2, true, HowMany.Partial);
		await test(1, 156 - 123, 123, 156, 2, false, HowMany.TooMany);
		await test(1, 156 - 123, 123, 156, 3, false, HowMany.Partial);
	});

	it("concurrency, single request, exact", async () => {
		await test(2, 156 - 123, 123, 156, 1, true);
		await test(2, 156 - 123, 123, 156, 1, true, HowMany.TooMany);
		await test(2, 156 - 123, 123, 156, 2, true, HowMany.Partial);
		// here, the number of actual requests is Ok to be 2..3
		await test(2, 156 - 123, 123, 156, 3, false);
		await test(2, 156 - 123, 123, 156, 3, false, HowMany.TooMany);
		await test(2, 156 - 123, 123, 156, 3, false, HowMany.Partial);
	});

	it("no concurrency, multiple requests", async () => {
		await test(1, 10, 123, 156, 4, true);
		await test(1, 10, 123, 156, 4, false);
		await test(1, 10, 123, 156, 3, false, HowMany.TooMany);
	});

	it("two concurrent requests exact", async () => {
		await test(2, 10, 123, 153, 3, true);
		await test(2, 10, 123, 153, 3, true, HowMany.TooMany);
		await test(2, 10, 123, 153, 6, true, HowMany.Partial);
		await test(2, 10, 123, 153, 5, false);
		await test(2, 10, 123, 153, 5, false, HowMany.TooMany);
		await test(2, 10, 123, 153, 8, false, HowMany.Partial);
	});

	it("two concurrent requests one over", async () => {
		await test(2, 10, 123, 154, 4, true);
		// here, the number of actual requests is Ok to be 4..5
		await test(2, 10, 123, 154, 5, false);
	});

	it("four concurrent requests", async () => {
		await test(4, 10, 123, 156, 4, true);
		// here, the number of actual requests is Ok to be 4..7
		await test(4, 10, 123, 156, 7, false);
	});

	it("cancellation", async () => {
		await testCancel(1, 1000, 502, 10, 60);
		await testCancel(1, undefined, 502, 10, 60);
	});

	it("exception in request", async () => {
		const logger = new MockLogger();

		const manager = new ParallelRequests<number>(
			1,
			100,
			10,
			logger.toTelemetryLogger(),
			async (request: number, _from: number, _to: number) => {
				throw new Error("request");
			},
			(deltas: number[]) => {
				throw new Error("response");
			},
		);

		let success = true;
		try {
			await manager.run(10);
		} catch (error: any) {
			success = false;
			assert(error.message === "request");
		}
		assert(!success);
		logger.assertMatchNone([{ category: "error" }]);
	});

	it("exception in response", async () => {
		const logger = new MockLogger();

		const manager = new ParallelRequests<number>(
			1,
			100,
			10,
			logger.toTelemetryLogger(),
			async (request: number, _from: number, _to: number) => {
				return { cancel: false, partial: false, payload: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
			},
			(deltas: number[]) => {
				throw new Error("response");
			},
		);

		let success = true;
		try {
			await manager.run(10);
		} catch (error: any) {
			success = false;
			assert(error.message === "response");
		}
		assert(!success);
		logger.assertMatchNone([{ category: "error" }]);
	});

	it("test no more ops", async () => {
		await testCore(
			1, // concurrency
			5000, // payloadSize
			100, // from
			5100, // to
			false, // knownTo
			[() => ({ partial: false, cancel: false, payload: [] })],
		);
	});

	it("test partial responses #1", async () => {
		// returning partial empty repsonse is not allowed - see assert 0x10f.
		await assert.rejects(async () =>
			testCore(
				1, // concurrency
				5000, // payloadSize
				100, // from
				200, // to
				true, // knownTo
				[
					() => ({ partial: true, cancel: false, payload: [] }),
					() => ({ partial: false, cancel: false, payload: genPayload(100, 200) }),
				],
			),
		);
	});

	it("test partial responses #2", async () => {
		// knownTo === true means client knows there are ops, but service tells us there are none.
		// it should result in client comming back and asking for more
		await testCore(
			1, // concurrency
			5000, // payloadSize
			100, // from
			200, // to
			true, // knownTo
			[
				() => ({ partial: false, cancel: false, payload: [] }),
				() => ({ partial: false, cancel: false, payload: genPayload(100, 200) }),
			],
			1, // dispatchesTotal
		);
	});

	it("test partial responses #3", async () => {
		await testCore(
			1, // concurrency
			5000, // payloadSize
			100, // from
			200, // to
			true, // knownTo
			[
				() => ({ partial: true, cancel: false, payload: genPayload(100, 150) }),
				() => ({ partial: false, cancel: false, payload: genPayload(150, 200) }),
			],
		);
	});

	it("test partial but complete response", async () => {
		// it should not matter if there are more - client got all it needed.
		await testCore(
			1, // concurrency
			5000, // payloadSize
			100, // from
			200, // to
			true, // knownTo
			[() => ({ partial: true, cancel: false, payload: genPayload(100, 200) })],
		);
	});

	it("test tail #1", async () => {
		await testCore(
			1, // concurrency
			5000, // payloadSize
			100, // from
			5100, // to
			false, // knownTo
			[() => ({ partial: false, cancel: false, payload: genPayload(100, 200) })],
		);
	});

	it("test tail #2", async () => {
		await testCore(
			1, // concurrency
			5000, // payloadSize
			100, // from
			5100, // to
			false, // knownTo
			[
				() => ({ partial: true, cancel: false, payload: genPayload(100, 200) }),
				() => ({ partial: false, cancel: false, payload: genPayload(200, 202) }),
			],
		);
	});

	it("test complete chunk #1", async () => {
		// We hit the chunk size and client does not need more, so there should be only one request.
		await testCore(
			1, // concurrency
			5000, // payloadSize
			100, // from
			5100, // to
			true, // knownTo
			[() => ({ partial: false, cancel: false, payload: genPayload(100, 5100) })],
		);
	});

	it("test complete chunk #2", async () => {
		// We hit the chunk size and client does not need more, so there should be only one request.
		await testCore(
			1, // concurrency
			5000, // payloadSize
			100, // from
			5100, // to
			true, // knownTo
			[() => ({ partial: true, cancel: false, payload: genPayload(100, 5100) })],
		);
	});

	it("test complete chunk #3", async () => {
		// Here, because we do not know how long is the file, it will turn around and ask for more if we hit the chunk size.
		await testCore(
			1, // concurrency
			5000, // payloadSize
			100, // from
			5100, // to
			false, // knownTo
			[
				() => ({ partial: true, cancel: false, payload: genPayload(100, 5100) }),
				() => ({ partial: false, cancel: false, payload: [] }),
			],
		);
	});

	it("test complete chunk #4", async () => {
		// The system should trust `partial` data, even if we hit the chunk size - if there are no more, then there are no more.
		await testCore(
			1, // concurrency
			5000, // payloadSize
			100, // from
			5100, // to
			false, // knownTo
			[() => ({ partial: false, cancel: false, payload: genPayload(100, 5100) })],
		);
	});
});
