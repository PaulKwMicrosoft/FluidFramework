import {
	configuredSharedTreeAlpha,
	getSharedTreeAuthority,
	TextAsTree,
	TreeViewConfiguration,
	SchemaFactory,
	type ContainerSchema,
	type ITree,
} from "fluid-framework/alpha";

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
