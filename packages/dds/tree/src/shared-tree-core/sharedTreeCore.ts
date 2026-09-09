/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { IFluidLoadable, ITelemetryBaseLogger } from "@fluidframework/core-interfaces";
import { assert, fail, unreachableCase } from "@fluidframework/core-utils/internal";
import type { IChannelStorageService } from "@fluidframework/datastore-definitions/internal";
import type { ISnapshotTree } from "@fluidframework/driver-definitions/internal";
import type {
	IIdCompressor,
	SessionId,
	SessionSpaceCompressedId,
} from "@fluidframework/id-compressor";
import type {
	IExperimentalIncrementalSummaryContext,
	IRuntimeMessageCollection,
	ISummaryTreeWithStats,
	ITelemetryContext,
} from "@fluidframework/runtime-definitions/internal";
import { SummaryTreeBuilder } from "@fluidframework/runtime-utils/internal";
import type {
	IChannelView,
	IFluidSerializer,
} from "@fluidframework/shared-object-base/internal";
import { createChildLogger, UsageError } from "@fluidframework/telemetry-utils/internal";

import type { CodecWriteOptions, DependentFormatVersion, IJsonCodec } from "../codec/index.js";
import {
	type ChangeFamily,
	type ChangeFamilyEditor,
	type GraphCommit,
	replaceChange,
	type RevisionTag,
	RevisionTagCodec,
	type SchemaAndPolicy,
	type SchemaPolicy,
	type TreeStoredSchemaRepository,
} from "../core/index.js";
import {
	type JsonCompatibleReadOnly,
	brand,
	type Breakable,
	type WithBreakable,
	throwIfBroken,
	breakingClass,
	readAndParseSnapshotBlob,
} from "../util/index.js";

import type { BranchId, SharedTreeBranch } from "./branch.js";
import { BranchCommitEnricher } from "./branchCommitEnricher.js";
import type { ChangeEnricher } from "./changeEnricher.js";
import { DefaultResubmitMachine } from "./defaultResubmitMachine.js";
import { EditManager, minimumPossibleSequenceNumber } from "./editManager.js";
import { makeEditManagerCodecBuilder } from "./editManagerCodecs.js";
import type { EditManagerFormatVersion, SeqNumber } from "./editManagerFormatCommons.js";
import { EditManagerSummarizer } from "./editManagerSummarizer.js";
import { type MessageEncodingContext, makeMessageCodecBuilder } from "./messageCodecs.js";
import type { MessageFormatVersion } from "./messageFormat.js";
import type { DecodedMessage } from "./messageTypes.js";
import type { ResubmitMachine } from "./resubmitMachine.js";
import {
	minVersionToSharedTreeSummaryFormatVersion,
	summarizablesTreeKey,
	supportedSharedTreeSummaryFormatVersions,
	type SharedTreeSummaryFormatVersion,
	type Summarizable,
	type SummaryElementParser,
	type SummaryElementStringifier,
} from "./summaryTypes.js";
import { VersionedSummarizer } from "./versionedSummarizer.js";
import {
	readAuthorityEnvelope,
	readEncodedAdvance,
	type AuthorityEnvelope,
	type ExternalAuthorityConfiguration,
	type ExternalAuthorityAdvance,
	type ExternalAuthorityOutcome,
	type ExternalAuthorityState,
	authorityBootstrapKey,
	validateAuthorityBootstrap,
	type AuthorityBootstrapMetadata,
} from "./externalAuthority.js";

export interface ClonableSchemaAndPolicy extends SchemaAndPolicy {
	schema: TreeStoredSchemaRepository;
}

export interface SharedTreeCoreOptionsInternal extends CodecWriteOptions {
	readonly externalAuthority?: ExternalAuthorityConfiguration;
	/**
	 * See {@link SharedTreeOptionsBeta.healUnresolvableIdentifiersOnDecode}.
	 */
	readonly healUnresolvableIdentifiersOnDecode?: boolean;
}

export interface EnrichmentConfig<TChange> {
	readonly enricher: ChangeEnricher<TChange>;
	readonly resubmitMachine?: ResubmitMachine<TChange>;
}

/**
 * Generic shared tree, which needs to be configured with indexes, field kinds and other configuration.
 */
@breakingClass
export class SharedTreeCore<TEditor extends ChangeFamilyEditor, TChange>
	extends VersionedSummarizer<SharedTreeSummaryFormatVersion>
	implements WithBreakable, Summarizable
{
	private readonly editManager: EditManager<TEditor, TChange, ChangeFamily<TEditor, TChange>>;
	private readonly externalAuthorityConfiguration: ExternalAuthorityConfiguration | undefined;
	private readonly authorityListeners = new Set<() => void>();
	private readonly authorityReceipts = new Map<
		string,
		(result: ExternalAuthorityOutcome) => void
	>();
	private authorityInitialized = false;
	private readonly summarizables: readonly [EditManagerSummarizer<TChange>, ...Summarizable[]];
	/**
	 * The sequence number that this instance is at.
	 * This number is artificial in that it is made up by this instance as opposed to being provided by the runtime.
	 * Is `undefined` after (and only after) this instance is attached.
	 */
	private detachedRevision: SeqNumber | undefined = minimumPossibleSequenceNumber;

	/**
	 * Used to encode/decode messages sent to/received from the Fluid runtime.
	 *
	 * @remarks Since there is currently only one format, this can just be cached on the class.
	 * With more write formats active, it may make sense to keep around the "usual" format codec
	 * (the one for the current persisted configuration) and resolve codecs for different versions
	 * as necessary (e.g. an upgrade op came in, or the configuration changed within the collab window
	 * and an op needs to be interpreted which isn't written with the current configuration).
	 */
	private readonly messageCodec: IJsonCodec<
		DecodedMessage<TChange>,
		unknown,
		unknown,
		MessageEncodingContext
	>;

	private readonly enrichers: Map<BranchId, EnricherState<TChange>> = new Map();

	public readonly mintRevisionTag: () => RevisionTag;

	private readonly schemaAndPolicy: ClonableSchemaAndPolicy;

	/**
	 * @param summarizables - Summarizers for all indexes used by this tree
	 * @param changeFamily - The change family
	 * @param editManager - The edit manager
	 * @param runtime - The IFluidDataStoreRuntime which contains the shared object
	 * @param editor - Used to edit the state of the tree. Edits will be immediately applied locally to the tree.
	 * If there is no transaction currently ongoing, then the edits will be submitted to Fluid immediately as well.
	 */
	public constructor(
		public readonly breaker: Breakable,
		public readonly sharedObject: IChannelView & IFluidLoadable,
		public readonly serializer: IFluidSerializer,
		public readonly submitLocalMessage: (content: unknown, localOpMetadata?: unknown) => void,
		logger: ITelemetryBaseLogger | undefined,
		summarizables: readonly Summarizable[],
		protected readonly changeFamily: ChangeFamily<TEditor, TChange>,
		options: SharedTreeCoreOptionsInternal,
		changeFormatVersionForEditManager: DependentFormatVersion<EditManagerFormatVersion>,
		changeFormatVersionForMessage: DependentFormatVersion<MessageFormatVersion>,
		protected readonly idCompressor: IIdCompressor,
		schema: TreeStoredSchemaRepository,
		schemaPolicy: SchemaPolicy,
		enrichmentConfig?: EnrichmentConfig<TChange>,
		public readonly getEditor: () => TEditor = () => this.getLocalBranch().editor,
	) {
		super(
			summarizablesTreeKey,
			minVersionToSharedTreeSummaryFormatVersion(options.minVersionForCollab),
			supportedSharedTreeSummaryFormatVersions,
			true /* supportPreVersioningFormat */,
		);

		this.schemaAndPolicy = {
			schema,
			policy: schemaPolicy,
		};
		this.externalAuthorityConfiguration =
			options.externalAuthority === undefined
				? undefined
				: Object.freeze({ ...options.externalAuthority });

		const rebaseLogger = createChildLogger({
			logger,
			namespace: "Rebase",
		});

		this.mintRevisionTag = () => this.idCompressor.generateCompressedId();
		/**
		 * A random ID that uniquely identifies this client in the collab session.
		 * This is sent alongside every op to identify which client the op originated from.
		 * This is used rather than the Fluid client ID because the Fluid client ID is not stable across reconnections.
		 */
		const localSessionId = idCompressor.localSessionId;
		this.editManager = new EditManager(
			changeFamily,
			localSessionId,
			this.mintRevisionTag,
			(branchId) => this.registerSharedBranch(branchId),
			rebaseLogger,
			options.externalAuthority !== undefined,
		);

		this.registerSharedBranch("main");

		const revisionTagCodec = new RevisionTagCodec(idCompressor);
		const editManagerCodec = makeEditManagerCodecBuilder<TChange>().build({
			...options,
			changeCodecs: this.editManager.changeFamily.codecs,
			dependentChangeFormatVersion: changeFormatVersionForEditManager,
			revisionTagCodec,
		});
		this.summarizables = [
			new EditManagerSummarizer(
				this.editManager,
				editManagerCodec,
				this.idCompressor,
				options.minVersionForCollab,
				this.schemaAndPolicy,
				options.healUnresolvableIdentifiersOnDecode === true
					? { sharedObjectId: sharedObject.id }
					: undefined,
			),
			...summarizables,
		];
		assert(
			new Set(this.summarizables.map((e) => e.key)).size === this.summarizables.length,
			0x350 /* Index summary element keys must be unique */,
		);

		this.messageCodec = makeMessageCodecBuilder<TChange>().build({
			...options,
			changeCodecs: changeFamily.codecs,
			dependentChangeFormatVersion: changeFormatVersionForMessage,
			revisionTagCodec: new RevisionTagCodec(idCompressor),
		});

		if (enrichmentConfig !== undefined) {
			this.registerSharedBranchForEditing(
				"main",
				enrichmentConfig.enricher,
				enrichmentConfig.resubmitMachine,
			);
		}
	}

	// TODO: SharedObject's merging of the two summary methods into summarizeCore is not what we want here:
	// We might want to not subclass it, or override/reimplement most of its functionality.
	protected summarizeInternal(props: {
		stringify: SummaryElementStringifier;
		fullTree?: boolean;
		trackState?: boolean;
		telemetryContext?: ITelemetryContext;
		incrementalSummaryContext?: IExperimentalIncrementalSummaryContext;
		builder: SummaryTreeBuilder;
	}): void {
		const { stringify, fullTree, telemetryContext, incrementalSummaryContext, builder } =
			props;
		if (this.externalAuthorityConfiguration !== undefined) {
			builder.addBlob(
				authorityBootstrapKey,
				stringify({
					externalAuthorityVersion: 1,
					configuration: this.externalAuthorityConfiguration,
				} satisfies AuthorityBootstrapMetadata),
			);
		}
		const summarizableBuilder = new SummaryTreeBuilder();
		// Merge the summaries of all summarizables together under a single ISummaryTree
		for (const s of this.summarizables) {
			// Add the summarizable's path in the summary tree to the incremental summary context's
			// summary path, so that the summarizable can use it to generate incremental summaries.
			const childIncrementalSummaryContext =
				incrementalSummaryContext === undefined
					? undefined
					: {
							...incrementalSummaryContext,
							summaryPath: `${incrementalSummaryContext.summaryPath}/${summarizablesTreeKey}/${s.key}`,
						};
			summarizableBuilder.addWithStats(
				s.key,
				s.summarize({
					stringify,
					fullTree,
					telemetryContext,
					incrementalSummaryContext: childIncrementalSummaryContext,
				}),
			);
		}
		builder.addWithStats(summarizablesTreeKey, summarizableBuilder.getSummaryTree());
	}

	protected async loadInternal(
		services: IChannelStorageService,
		parse: SummaryElementParser,
	): Promise<void> {
		const hasAuthorityMetadata = await services.contains(authorityBootstrapKey);
		if (this.externalAuthorityConfiguration !== undefined) {
			if (!hasAuthorityMetadata) {
				throw new UsageError(
					"External authority bootstrap metadata is missing; ordinary or older prototype summaries cannot be reinterpreted",
				);
			}
			validateAuthorityBootstrap(
				await readAndParseSnapshotBlob(authorityBootstrapKey, services, parse),
				this.externalAuthorityConfiguration,
			);
		} else if (hasAuthorityMetadata) {
			throw new UsageError(
				"An external authority summary cannot be loaded by an ordinary SharedTree factory",
			);
		}
		const [editManagerSummarizer, ...summarizables] = this.summarizables;
		const loadEditManager = this.loadSummarizable(editManagerSummarizer, services, parse);
		const loadSummarizables = summarizables.map(async (s) =>
			this.loadSummarizable(s, services, parse),
		);

		if (this.detachedRevision === undefined) {
			await Promise.all([loadEditManager, ...loadSummarizables]);
		} else {
			// If we are detached but loading from a summary, then we need to update our detached revision to ensure that it is ahead of all detached revisions in the summary.
			// First, finish loading the edit manager so that we can inspect the sequence numbers of the commits on the trunk.
			await loadEditManager;

			const latestDetachedSequenceNumber = this.editManager.getLatestSequenceNumber();
			// When we load a summary for a tree that was never attached,
			// latestDetachedSequenceNumber is either undefined (no commits in summary) or negative (all commits in summary were made while detached).
			// We only need to update `this.detachedRevision` in the latter case.
			if (latestDetachedSequenceNumber !== undefined && latestDetachedSequenceNumber < 0) {
				this.detachedRevision = latestDetachedSequenceNumber;
			}
			await Promise.all(loadSummarizables);
		}
	}

	@throwIfBroken
	public summarizeCore(
		serializer: IFluidSerializer,
		telemetryContext?: ITelemetryContext,
		incrementalSummaryContext?: IExperimentalIncrementalSummaryContext,
		fullTree?: boolean,
	): ISummaryTreeWithStats {
		return this.summarize({
			stringify: (contents: unknown) =>
				serializer.stringify(contents, this.sharedObject.handle),
			fullTree,
			telemetryContext,
			incrementalSummaryContext,
		});
	}

	public async loadCore(services: IChannelStorageService): Promise<void> {
		assert(
			this.getLocalBranch().getHead() === this.editManager.getTrunkHead("main"),
			0xaaa /* All local changes should be applied to the trunk before loading from summary */,
		);
		await super.load(services, (contents) => this.serializer.parse(contents));
	}

	private registerSharedBranch(branchId: BranchId): void {
		const branch = this.editManager.getLocalBranch(branchId);
		branch.events.on("beforeChange", (change) => {
			if (
				change.type === "append" &&
				this.externalAuthorityConfiguration !== undefined &&
				this.authorityInitialized
			) {
				for (const commit of change.newCommits) {
					this.validateAuthorityChange(commit.change);
				}
			}
			if (change.type === "append") {
				if (this.detachedRevision === undefined) {
					// Commit enrichment is only necessary for changes that will be submitted as ops, and changes issued while detached are not submitted.
					this.getCommitEnricher(branchId).prepareChanges(change.newCommits);
				}

				for (const commit of change.newCommits) {
					this.submitCommit(branchId, commit, this.schemaAndPolicy, false);
				}
			}
		});
	}

	private async loadSummarizable(
		summarizable: Summarizable,
		services: IChannelStorageService,
		parse: SummaryElementParser,
	): Promise<void> {
		return summarizable.load(
			scopeStorageService(services, summarizablesTreeKey, summarizable.key),
			parse,
		);
	}

	/**
	 * Submits an op to the Fluid runtime containing the given commit
	 * @param commit - the commit to submit
	 * @returns the submitted commit. This is undefined if the underlying `SharedObject` is not attached,
	 * and may differ from `commit` due to enrichments like detached tree refreshers.
	 */
	protected submitCommit(
		branchId: BranchId,
		commit: GraphCommit<TChange>,
		schemaAndPolicy: ClonableSchemaAndPolicy,
		isResubmit: boolean,
	): void {
		assert(
			this.sharedObject.isAttached() === (this.detachedRevision === undefined),
			0x95a /* Detached revision should only be set when not attached */,
		);

		// Edits submitted before the first attach are treated as sequenced because they will be included
		// in the attach summary that is uploaded to the service.
		// Until this attach workflow happens, this instance essentially behaves as a centralized data structure.
		if (this.detachedRevision !== undefined) {
			const newRevision: SeqNumber = brand((this.detachedRevision as number) + 1);
			this.detachedRevision = newRevision;
			this.editManager.addSequencedChanges(
				[commit],
				this.editManager.localSessionId,
				newRevision,
				this.detachedRevision,
				branchId,
			);
			this.editManager.advanceMinimumSequenceNumber(newRevision, false);
			return undefined;
		}

		const enrichedCommit = isResubmit
			? commit
			: replaceChange(commit, this.getCommitEnricher(branchId).retrieveChange(commit));

		this.submitMessage(
			{
				type: "commit",
				commit: enrichedCommit,
				sessionId: this.editManager.localSessionId,
				branchId,
			},
			schemaAndPolicy,
		);

		this.getResubmitMachine(branchId).onCommitSubmitted(enrichedCommit);
	}

	protected submitBranchCreation(branchId: BranchId): void {
		this.submitMessage(
			{ type: "branch", sessionId: this.editManager.localSessionId, branchId },
			this.schemaAndPolicy,
		);
	}

	private submitMessage(
		message: DecodedMessage<TChange>,
		schemaAndPolicy: ClonableSchemaAndPolicy,
	): void {
		const encodedMessage = this.messageCodec.encode(message, {
			idCompressor: this.idCompressor,
			schema: schemaAndPolicy,
		});
		this.submitLocalMessage(this.wrapAuthorityMessage("ordinary", encodedMessage), {
			// Clone the schema to ensure that during resubmit the schema has not been mutated by later changes
			schema: schemaAndPolicy.schema.clone(),
			policy: schemaAndPolicy.policy,
		});
	}

	/**
	 * Process a bunch of messages from the runtime. SharedObject will call this method with a bunch of messages.
	 */
	public processMessagesCore(messagesCollection: IRuntimeMessageCollection): void {
		const { envelope, local, messagesContent } = messagesCollection;
		const commits: GraphCommit<TChange>[] = [];
		let messagesSessionId: SessionId | undefined;
		let branchId: BranchId | undefined;

		const processBunch = (branch: BranchId): void => {
			assert(messagesSessionId !== undefined, 0xada /* Messages must have a session ID */);
			this.processCommits(
				messagesSessionId,
				brand(envelope.sequenceNumber),
				brand(envelope.referenceSequenceNumber),
				local,
				branch,
				commits,
			);

			commits.length = 0;
			branchId = undefined;
		};

		// Get a list of all the commits from the messages.
		for (const messageContent of messagesContent) {
			let contents = messageContent.contents;
			if (this.externalAuthorityConfiguration !== undefined) {
				const wrapper = readAuthorityEnvelope(contents, this.externalAuthorityConfiguration);
				if (wrapper.kind === "advance") {
					if (branchId !== undefined) {
						processBunch(branchId);
					}
					const encoded = readEncodedAdvance(wrapper.content);
					const decodedCommits = encoded.commits.map((content) => {
						const draftMessage = this.messageCodec.decode(content, {
							idCompressor: this.idCompressor,
						});
						assert(
							draftMessage.type === "commit" && draftMessage.branchId === "main",
							"Authority draft must contain main-branch commits",
						);
						this.validateAuthorityChange(draftMessage.commit.change);
						return draftMessage.commit;
					});
					const approvedPrefix = encoded.approvedPrefix.map((id) => {
						const revision = this.idCompressor.tryRecompress(
							id as Parameters<IIdCompressor["tryRecompress"]>[0],
						);
						assert(revision !== undefined, "Unknown approval identity");
						return revision;
					});
					const result = this.editManager.advanceExternalAuthority(
						{ ...encoded, approvedPrefix, commits: decodedCommits },
						brand(envelope.sequenceNumber),
						this.serializer.stringify(wrapper, this.sharedObject.handle),
					);
					// An authority self-echo can change L's base too.
					if (result === "applied") {
						this.authorityInitialized = true;
						this.tryGetResubmitMachine("main")?.onSequencedCommitApplied("root", false);
					}
					this.authorityReceipts.get(encoded.batchId)?.(result);
					this.authorityReceipts.delete(encoded.batchId);
					continue;
				}
				contents = wrapper.content;
			}
			// Empty context object is passed in, as our decode function is schema-agnostic.
			const message = this.messageCodec.decode(contents, {
				idCompressor: this.idCompressor,
			});

			if (messagesSessionId !== undefined) {
				assert(
					messagesSessionId === message.sessionId,
					0xad9 /* All messages in a bunch must have the same session ID */,
				);
			}
			messagesSessionId = message.sessionId;

			const type = message.type;
			switch (type) {
				case "commit": {
					if (this.externalAuthorityConfiguration !== undefined && this.authorityInitialized) {
						this.validateAuthorityChange(message.commit.change);
					}
					if (branchId !== undefined && message.branchId !== branchId) {
						processBunch(branchId);
					}

					branchId = message.branchId;
					commits.push(message.commit);
					break;
				}
				case "branch": {
					if (branchId !== undefined) {
						processBunch(branchId);
					}
					this.editManager.sequenceBranchCreation(
						messagesSessionId,
						brand(envelope.referenceSequenceNumber),
						message.branchId,
					);
					break;
				}
				default: {
					unreachableCase(type);
				}
			}
		}

		if (branchId !== undefined) {
			processBunch(branchId);
		}

		this.editManager.advanceMinimumSequenceNumber(brand(envelope.minimumSequenceNumber));
		if (this.externalAuthorityConfiguration !== undefined) {
			for (const listener of this.authorityListeners) {
				listener();
			}
		}
	}

	private processCommits(
		sessionId: SessionId,
		sequenceNumber: SeqNumber,
		referenceSequenceNumber: SeqNumber,
		isLocal: boolean,
		branchId: BranchId,
		commits: readonly GraphCommit<TChange>[],
	): void {
		this.editManager.addSequencedChanges(
			commits,
			sessionId,
			sequenceNumber,
			referenceSequenceNumber,
			branchId,
		);

		// Update the resubmit machine for each commit applied.
		for (const commit of commits) {
			this.tryGetResubmitMachine(branchId)?.onSequencedCommitApplied(commit.revision, isLocal);
		}
	}

	public getLocalBranch(): SharedTreeBranch<TEditor, TChange> {
		return this.editManager.getLocalBranch("main");
	}

	public getExternalAuthorityState(): ExternalAuthorityState<TChange> {
		return this.editManager.getExternalAuthorityState();
	}

	public get externalAuthorityEnabled(): boolean {
		return this.externalAuthorityConfiguration !== undefined;
	}

	public getStableRevision(revision: RevisionTag): string {
		assert(revision !== "root", "The root has no stable edit identity");
		return this.idCompressor.decompress(revision);
	}

	public onExternalAuthorityChanged(listener: () => void): () => void {
		assert(
			this.externalAuthorityConfiguration !== undefined,
			"External authority mode is not enabled",
		);
		this.authorityListeners.add(listener);
		return () => this.authorityListeners.delete(listener);
	}

	protected validateAuthorityChange(_change: TChange): void {}

	private wrapAuthorityMessage(kind: AuthorityEnvelope["kind"], content: unknown): unknown {
		return this.externalAuthorityConfiguration === undefined
			? content
			: ({
					externalAuthorityVersion: 1,
					configuration: this.externalAuthorityConfiguration,
					kind,
					content,
				} satisfies AuthorityEnvelope);
	}

	public async publishExternalAuthority(
		advance: ExternalAuthorityAdvance<TChange>,
	): Promise<ExternalAuthorityOutcome> {
		assert(
			this.externalAuthorityConfiguration !== undefined,
			"External authority mode is not enabled",
		);
		assert(
			this.detachedRevision === undefined,
			"Attach the tree before publishing authority advances",
		);
		assert(
			!this.authorityReceipts.has(advance.batchId),
			"Authority batch is already in flight",
		);
		for (const commit of advance.commits) {
			this.validateAuthorityChange(commit.change);
		}
		const encoded = {
			batchId: advance.batchId,
			expected: advance.expected,
			next: advance.next,
			approvedPrefix: advance.approvedPrefix.map((revision) => {
				assert(revision !== "root", "Cannot approve the root revision");
				return this.idCompressor.decompress(revision);
			}),
			commits: advance.commits.map((commit) =>
				this.messageCodec.encode(
					{
						type: "commit",
						branchId: "main",
						sessionId: this.idCompressor.localSessionId,
						commit,
					},
					{ idCompressor: this.idCompressor, schema: this.schemaAndPolicy },
				),
			),
		};
		const receipt = new Promise<ExternalAuthorityOutcome>((resolve) => {
			this.authorityReceipts.set(advance.batchId, resolve);
		});
		this.submitLocalMessage(this.wrapAuthorityMessage("advance", encoded));
		return receipt;
	}

	public getSharedBranchIds(): string[] {
		return this.editManager
			.getSharedBranchIds()
			.filter((id): id is SessionSpaceCompressedId => id !== "main")
			.map((id) => this.idCompressor.decompress(id));
	}
	public createSharedBranch(): string {
		const branchId = this.idCompressor.generateCompressedId();
		this.addBranch(branchId);
		this.submitBranchCreation(branchId);
		return this.idCompressor.decompress(branchId);
	}

	protected addBranch(branchId: BranchId): void {
		this.editManager.addNewBranch(branchId);
	}

	public getSharedBranch(branchId: BranchId): SharedTreeBranch<TEditor, TChange> {
		return this.editManager.getLocalBranch(branchId);
	}

	public didAttach(): void {
		this.detachedRevision = undefined;
	}

	public reSubmitCore(content: JsonCompatibleReadOnly, localOpMetadata: unknown): void {
		let ordinaryContent = content;
		if (this.externalAuthorityConfiguration !== undefined) {
			const wrapper = readAuthorityEnvelope(content, this.externalAuthorityConfiguration);
			if (wrapper.kind === "advance") {
				this.submitLocalMessage(this.serializer.decode(wrapper), localOpMetadata);
				return;
			}
			ordinaryContent = wrapper.content as JsonCompatibleReadOnly;
		}
		// Empty context object is passed in, as our decode function is schema-agnostic.
		const message = this.messageCodec.decode(this.serializer.decode(ordinaryContent), {
			idCompressor: this.idCompressor,
		});

		const type = message.type;
		switch (type) {
			case "commit": {
				const {
					commit: { revision },
					branchId,
				} = message;

				const resubmitMachine = this.getResubmitMachine(branchId);

				const getLocalCommits = (): GraphCommit<TChange>[] => {
					const localCommits = this.editManager.getLocalCommits(branchId);
					const revisionIndex = localCommits.findIndex((c) => c.revision === revision);
					assert(revisionIndex >= 0, 0xbdb /* revision must exist in local commits */);
					return localCommits.slice(revisionIndex);
				};

				assert(
					isClonableSchemaPolicy(localOpMetadata),
					0x95e /* Local metadata must contain schema and policy. */,
				);

				const enrichedCommit = resubmitMachine.getEnrichedCommit(revision, getLocalCommits);
				if (enrichedCommit !== undefined) {
					this.submitCommit(branchId, enrichedCommit, localOpMetadata, true);
				}

				break;
			}
			case "branch": {
				this.submitBranchCreation(message.branchId);
				break;
			}
			default: {
				unreachableCase(type);
			}
		}
	}

	public rollback(content: JsonCompatibleReadOnly, localOpMetadata: unknown): void {
		let ordinaryContent = content;
		if (this.externalAuthorityConfiguration !== undefined) {
			const wrapper = readAuthorityEnvelope(content, this.externalAuthorityConfiguration);
			if (wrapper.kind === "advance") {
				assert(false, "Rollback of an authority publication is not supported");
			}
			ordinaryContent = wrapper.content as JsonCompatibleReadOnly;
		}
		// Empty context object is passed in, as our decode function is schema-agnostic.
		const message = this.messageCodec.decode(this.serializer.decode(ordinaryContent), {
			idCompressor: this.idCompressor,
		});

		const type = message.type;
		switch (type) {
			case "commit": {
				const {
					commit: { revision },
					branchId,
				} = message;
				const branch = this.editManager.getLocalBranch(branchId);
				const head = branch.getHead();
				assert(head.revision === revision, 0xc6b /* Can only rollback latest commit */);
				const newHead = head.parent ?? fail(0xc6c /* must have parent */);
				branch.removeAfter(newHead);
				this.getResubmitMachine(branchId).onCommitRollback(head);
				break;
			}
			case "branch": {
				this.editManager.removeBranch(message.branchId);
				break;
			}
			default: {
				unreachableCase(type);
			}
		}
	}

	public applyStashedOp(content: JsonCompatibleReadOnly): void {
		let ordinaryContent = content;
		if (this.externalAuthorityConfiguration !== undefined) {
			const wrapper = readAuthorityEnvelope(content, this.externalAuthorityConfiguration);
			if (wrapper.kind === "advance") {
				// The runtime retains this for retransmission. No optimistic authority path.
				return;
			}
			ordinaryContent = wrapper.content as JsonCompatibleReadOnly;
		}
		// Empty context object is passed in, as our decode function is schema-agnostic.
		const message = this.messageCodec.decode(this.serializer.decode(ordinaryContent), {
			idCompressor: this.idCompressor,
		});

		const type = message.type;
		switch (type) {
			case "commit": {
				const {
					commit: { revision, change },
					branchId,
				} = message;
				this.editManager.getLocalBranch(branchId).apply({ change, revision });
				break;
			}
			case "branch": {
				this.editManager.addNewBranch(message.branchId);
				break;
			}
			default: {
				unreachableCase(type);
			}
		}
	}

	protected registerSharedBranchForEditing(
		branchId: BranchId,
		enricher: ChangeEnricher<TChange>,
		resubmitMachine?: ResubmitMachine<TChange>,
	): void {
		const commitEnricher = new BranchCommitEnricher(enricher);
		assert(!this.enrichers.has(branchId), 0xc6d /* Branch already registered */);
		this.enrichers.set(branchId, {
			enricher: commitEnricher,
			resubmitMachine: resubmitMachine ?? new DefaultResubmitMachine(enricher),
		});
	}

	private getResubmitMachine(branchId: BranchId): ResubmitMachine<TChange> {
		return this.getEnricherState(branchId).resubmitMachine;
	}

	private tryGetResubmitMachine(branchId: BranchId): ResubmitMachine<TChange> | undefined {
		return this.tryGetEnricherState(branchId)?.resubmitMachine;
	}

	public getCommitEnricher(branchId: BranchId): BranchCommitEnricher<TChange> {
		return this.getEnricherState(branchId).enricher;
	}

	private getEnricherState(branchId: BranchId): EnricherState<TChange> {
		return (
			this.tryGetEnricherState(branchId) ??
			fail(0xc6e /* Expected to have a resubmit machine for this branch */)
		);
	}

	private tryGetEnricherState(branchId: BranchId): EnricherState<TChange> | undefined {
		return this.enrichers.get(branchId);
	}
}

interface EnricherState<TChange> {
	readonly enricher: BranchCommitEnricher<TChange>;
	readonly resubmitMachine: ResubmitMachine<TChange>;
}

function isClonableSchemaPolicy(
	maybeSchemaPolicy: unknown,
): maybeSchemaPolicy is ClonableSchemaAndPolicy {
	const schemaAndPolicy = maybeSchemaPolicy as ClonableSchemaAndPolicy;
	return schemaAndPolicy.schema !== undefined && schemaAndPolicy.policy !== undefined;
}

/**
 * Compose an {@link IChannelStorageService} which prefixes all paths before forwarding them to the original service
 */
function scopeStorageService(
	service: IChannelStorageService,
	...pathElements: string[]
): IChannelStorageService {
	const scope = `${pathElements.join("/")}/`;

	return {
		async readBlob(path: string): Promise<ArrayBufferLike> {
			return service.readBlob(`${scope}${path}`);
		},
		async contains(path) {
			return service.contains(`${scope}${path}`);
		},
		async list(path) {
			return service.list(`${scope}${path}`);
		},
		getSnapshotTree(): ISnapshotTree | undefined {
			const snapshotTree = service.getSnapshotTree();
			if (snapshotTree === undefined) {
				return undefined;
			}
			let scopedTree = snapshotTree;
			for (const element of pathElements) {
				const tree = scopedTree.trees[element];
				assert(
					tree !== undefined,
					0xc20 /* snapshot tree not found for one of tree's summarizables */,
				);
				scopedTree = tree;
			}
			return scopedTree;
		},
	};
}
