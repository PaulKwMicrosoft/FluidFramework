import { AzureClient, type AzureClientProps } from "@fluidframework/azure-client";
import type { AzureClientPropsInternal } from "@fluidframework/azure-client/internal";
import { createDOProviderContainerRuntimeFactory } from "@fluidframework/fluid-static/internal";

export function createSummaryDisabledAzureClient(props: AzureClientProps): AzureClient {
	const internalProps: AzureClientPropsInternal = {
		...props,
		connection: { ...props.connection },
		createContainerRuntimeFactory: ({ schema, minVersionForCollaboration }) =>
			createDOProviderContainerRuntimeFactory({
				schema,
				minVersionForCollaboration,
				runtimeOptionOverrides: {
					summaryOptions: {
						summaryConfigOverrides: { state: "disabled" },
					},
				},
			}),
	};
	return new AzureClient(internalProps);
}
