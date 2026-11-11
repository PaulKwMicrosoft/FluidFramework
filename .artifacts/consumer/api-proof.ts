import {
	configuredSharedTreeAlpha,
	FluidClientVersion,
	getSharedTreeAuthority,
	TextAsTree,
	type ContainerSchema,
	type ExternalAuthorityConfiguration,
	type ITree,
	type SharedTreeAuthorityController,
	type SharedTreeAuthorityPublication,
} from "fluid-framework/alpha";

const authority: ExternalAuthorityConfiguration = {
	documentEpoch: "document",
	authorityId: "bridge",
	authorityEpoch: "epoch",
};
export const schema = {
	initialObjects: {
		tree: configuredSharedTreeAlpha({
			minVersionForCollab: FluidClientVersion.v2_80,
			externalAuthority: authority,
			enableDetachedRootEditing: true,
		}),
	},
} satisfies ContainerSchema;

export function controllerFor(tree: ITree): SharedTreeAuthorityController {
	return getSharedTreeAuthority(tree);
}

export async function publish(
	controller: SharedTreeAuthorityController,
	publication: SharedTreeAuthorityPublication,
): Promise<"applied" | "duplicate" | "stale"> {
	return controller.publishAdvance(publication);
}

export const textSchema = TextAsTree;
