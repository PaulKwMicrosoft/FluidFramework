/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import {
	validateAssertionError,
	validateUsageError,
} from "@fluidframework/test-runtime-utils/internal";
import { UsageError } from "@fluidframework/telemetry-utils/internal";
import * as Type from "typebox/type";

import {
	extractJsonValidator,
	type IJsonCodec,
	lazyCodecFamily,
	makeCodecFamily,
	withSchemaValidation,
} from "../../codec/index.js";
import {
	FormatValidatorBasic,
	FormatValidatorInterpreted,
} from "../../external-utilities/index.js";

describe("Codec APIs", () => {
	describe("withSchemaValidation", () => {
		const idCodec: IJsonCodec<number, number> = {
			encode: (x) => x,
			decode: (x) => x,
		};
		const codec = withSchemaValidation(Type.Number(), idCodec, FormatValidatorBasic);
		describe("rejects invalid data", () => {
			it("on encode", () => {
				assert.throws(
					() => codec.encode("bad data" as unknown as number),
					validateAssertionError(/Encoded data should validate/),
				);
			});

			it("on decode", () => {
				assert.throws(
					() => codec.decode("bad data" as unknown as number),
					validateAssertionError(/Data being decoded should validate/),
				);
			});

			it("using a per-call custom error handler", () => {
				assert.throws(
					() =>
						codec.decode("bad data" as unknown as number, undefined, (message) => {
							throw new UsageError(message ?? "Invalid input");
						}),
					validateUsageError("Encoded data does not match the expected schema."),
				);
				assert.throws(
					() => codec.decode("bad data" as unknown as number),
					validateAssertionError(/Data being decoded should validate/),
				);
			});
		});

		describe("accepts valid data", () => {
			it("on encode", () => {
				assert.equal(codec.encode(0), 0);
				assert.equal(codec.encode(5), 5);
			});

			it("on decode", () => {
				assert.equal(codec.decode(0), 0);
				assert.equal(codec.decode(91), 91);
			});
		});
	});

	describe("FormatValidatorInterpreted", () => {
		it("validates without dynamic code generation", () => {
			const originalFunction = globalThis.Function;
			globalThis.Function = (() => {
				throw new Error("Dynamic code generation is disabled.");
			}) as unknown as FunctionConstructor;

			try {
				const validator = extractJsonValidator(FormatValidatorInterpreted).compile(
					Type.Number(),
				);
				assert.equal(validator.check(42), true);
				assert.equal(validator.check("42"), false);
			} finally {
				globalThis.Function = originalFunction;
			}
		});
	});

	describe("lazyCodecFamily", () => {
		const idCodec: IJsonCodec<number, number> = {
			encode: (x) => x,
			decode: (x) => x,
		};

		it("builds the family once, when it is first used", () => {
			let builds = 0;
			const family = lazyCodecFamily(() => {
				builds += 1;
				return makeCodecFamily([
					[1, idCodec],
					[2, idCodec],
				]);
			});
			assert.equal(builds, 0);
			assert.deepEqual([...family.getSupportedFormats()], [1, 2]);
			assert.equal(builds, 1);
			assert.equal(family.resolve(2).encode(7), 7);
			assert.equal(family.resolve(1).decode(8), 8);
			assert.equal(builds, 1);
		});

		it("throws errors in building the family when it is used", () => {
			const family = lazyCodecFamily(() => {
				throw new Error("cannot build");
			});
			assert.throws(() => family.resolve(1), /cannot build/);
			assert.throws(() => [...family.getSupportedFormats()], /cannot build/);
		});
	});
});
