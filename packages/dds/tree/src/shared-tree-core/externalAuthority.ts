/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { GraphCommit, RevisionTag } from "../core/index.js";
import { assert } from "@fluidframework/core-utils/internal";

/**
 * Opt-in experimental authority protocol. All writers are trusted in this prototype.
 * Identity/epoch checks are fencing, not authentication.
 * @alpha @input
 */
export interface ExternalAuthorityConfiguration {
	readonly documentEpoch: string;
	readonly authorityId: string;
	readonly authorityEpoch: string;
}

export interface AuthorityEnvelope {
	readonly externalAuthorityVersion: 1;
	readonly configuration: ExternalAuthorityConfiguration;
	readonly kind: "ordinary" | "advance";
	readonly content: unknown;
}

export interface AuthorityBootstrapMetadata {
	readonly externalAuthorityVersion: 1;
	readonly configuration: ExternalAuthorityConfiguration;
}

export const authorityBootstrapKey = ".externalAuthority";

export function validateAuthorityBootstrap(
	content: unknown,
	expected: ExternalAuthorityConfiguration,
): void {
	assert(
		typeof content === "object" && content !== null,
		"Invalid authority bootstrap metadata",
	);
	const metadata = content as AuthorityBootstrapMetadata;
	assert(metadata.externalAuthorityVersion === 1, "Incompatible external authority bootstrap");
	assert(
		metadata.configuration?.documentEpoch === expected.documentEpoch,
		"Wrong authority document epoch",
	);
	assert(
		metadata.configuration?.authorityId === expected.authorityId,
		"Wrong authority identity",
	);
	assert(
		metadata.configuration?.authorityEpoch === expected.authorityEpoch,
		"Wrong authority epoch",
	);
}

export interface EncodedAdvance {
	readonly batchId: string;
	readonly expected: string;
	readonly next: string;
	readonly approvedPrefix: readonly string[];
	readonly commits: readonly unknown[];
}

export function readAuthorityEnvelope(
	content: unknown,
	expected: ExternalAuthorityConfiguration,
): AuthorityEnvelope {
	assert(
		typeof content === "object" && content !== null,
		"Authority envelope must be an object",
	);
	const envelope = content as AuthorityEnvelope;
	assert(envelope.externalAuthorityVersion === 1, "Incompatible external authority protocol");
	assert(
		envelope.kind === "ordinary" || envelope.kind === "advance",
		"Unknown authority envelope kind",
	);
	assert(
		envelope.configuration?.documentEpoch === expected.documentEpoch,
		"Wrong authority document epoch",
	);
	assert(
		envelope.configuration?.authorityId === expected.authorityId,
		"Wrong authority identity",
	);
	assert(
		envelope.configuration?.authorityEpoch === expected.authorityEpoch,
		"Wrong authority epoch",
	);
	return envelope;
}

export function readEncodedAdvance(content: unknown): EncodedAdvance {
	assert(
		typeof content === "object" && content !== null,
		"Authority advance must be an object",
	);
	const advance = content as EncodedAdvance;
	for (const value of [advance.batchId, advance.expected, advance.next]) {
		assert(
			typeof value === "string" && value.length > 0,
			"Authority identifiers must be nonempty strings",
		);
	}
	assert(
		Array.isArray(advance.approvedPrefix) &&
			advance.approvedPrefix.every((id) => typeof id === "string"),
		"Invalid approval identities",
	);
	assert(Array.isArray(advance.commits), "Invalid authority changes");
	return advance;
}

/** Internal, decoded representation. Revision tags never escape as public cut identities. */
export interface ExternalAuthorityAdvance<TChange> {
	readonly batchId: string;
	readonly expected: string;
	readonly next: string;
	readonly approvedPrefix: readonly RevisionTag[];
	readonly commits: readonly GraphCommit<TChange>[];
}

export type ExternalAuthorityOutcome = "applied" | "duplicate" | "stale";

export interface ExternalAuthorityState<TChange> {
	readonly checkpoint: string;
	readonly approved: GraphCommit<TChange>;
	readonly sequenced: GraphCommit<TChange>;
	readonly provisional: readonly GraphCommit<TChange>[];
}
