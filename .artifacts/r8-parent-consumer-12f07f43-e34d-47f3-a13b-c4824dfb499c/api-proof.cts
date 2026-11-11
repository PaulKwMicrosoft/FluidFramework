import {
	configuredSharedTreeAlpha,
	getSharedTreeAuthority,
	TextAsTree,
	TreeViewConfiguration,
	SchemaFactory,
	type ContainerSchema,
	type ITree,
	Tree,
	type TreeNode,
} from "fluid-framework/alpha";
import type {
	SharedTreeAuthorityNodeReference,
	SharedTreeAuthorityNodeResolution,
	SharedTreeAuthorityReferenceCapture,
	SharedTreeAuthorityReferenceOptions,
	SharedTreeAuthorityReferenceResult,
} from "@fluidframework/tree/alpha";

const sf = new SchemaFactory("r5-public-type-proof");
class Root extends sf.object("Root", { value: sf.number }) {}
const configuration = new TreeViewConfiguration({ schema: Root });

export const schema = {
	initialObjects: {
		tree: configuredSharedTreeAlpha({
			minVersionForCollab: "2.80.0",
			enableDetachedRootEditing: true,
			externalAuthority: {
				documentEpoch: "document",
				authorityId: "authority",
				authorityEpoch: "epoch",
			},
		}),
	},
} satisfies ContainerSchema;

export function normalize(tree: ITree): Promise<"applied" | "duplicate" | "stale"> {
	const authority = getSharedTreeAuthority(tree);
	const capture = authority.capture();
	const k = capture.editIds.length;
	const draft = authority.createDraft(capture, { afterPrefix: k });
	draft.viewWith(configuration).root.value = 42;
	return authority.publishAdvance({
		batchId: "normalize",
		nextCheckpoint: "normalized",
		capture,
		approvePrefix: k,
		draft,
	}).finally(() => {
		draft.dispose();
		capture.dispose();
	});
}

export const textSchema = TextAsTree;

export function counterparts(tree: ITree, liveNode: TreeNode): void {
	const authority = getSharedTreeAuthority(tree);
	const options: SharedTreeAuthorityReferenceOptions = {
		trackNodeReferences: true, maxNodes: 10000, maxDrafts: 16,
	};
	const capture: SharedTreeAuthorityReferenceCapture = authority.capture(options);
	const result: SharedTreeAuthorityReferenceResult = capture.reference(liveNode);
	const draft = authority.createDraft(capture, { afterPrefix: capture.editIds.length });
	draft.viewWith(configuration);
	if (result.kind === "tracked") {
		const reference: SharedTreeAuthorityNodeReference = result.reference;
		const resolved: SharedTreeAuthorityNodeResolution = capture.resolve(reference, draft);
		if (resolved.kind === "node" && Tree.is(resolved.node, Root)) {
			resolved.node.value = 42;
		}
		capture.resolve(reference, "live");
	}
	draft.dispose();
	capture.dispose();
}

export function rejectedTypes(tree: ITree, node: TreeNode): void {
	const authority = getSharedTreeAuthority(tree);
	// @ts-expect-error Reference methods require explicit capture opt-in.
	authority.capture().reference(node);
	// @ts-expect-error False does not opt in.
	authority.capture({ trackNodeReferences: false });
	// @ts-expect-error Limits must be numeric.
	authority.capture({ trackNodeReferences: true, maxNodes: "100" });
}
