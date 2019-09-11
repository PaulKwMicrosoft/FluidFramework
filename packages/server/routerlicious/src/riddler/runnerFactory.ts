/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import * as services from "@microsoft/fluid-server-services";
import { getOrCreateRepository } from "@microsoft/fluid-server-services-client";
import { MongoManager } from "@microsoft/fluid-server-services-core";
import * as utils from "@microsoft/fluid-server-services-utils";
import { Provider } from "nconf";
import { RiddlerRunner } from "./runner";
import { ITenantDocument } from "./tenantManager";

export class RiddlerResources implements utils.IResources {
    constructor(
        public tenantsCollectionName: string ,
        public mongoManager: MongoManager,
        public port: any,
        public loggerFormat: string,
        public baseOrdererUrl: string) {
    }

    public async dispose(): Promise<void> {
        await this.mongoManager.close();
    }
}

export class RiddlerResourcesFactory implements utils.IResourcesFactory<RiddlerResources> {
    public async create(config: Provider): Promise<RiddlerResources> {
        // Database connection
        const mongoUrl = config.get("mongo:endpoint") as string;
        const mongoFactory = new services.MongoDbFactory(mongoUrl);
        const mongoManager = new MongoManager(mongoFactory);
        const tenantsCollectionName = config.get("mongo:collectionNames:tenants");

        // Load configs for default tenants
        const db = await mongoManager.getDatabase();
        const collection = db.collection<ITenantDocument>(tenantsCollectionName);
        const tenants = config.get("tenantConfig") as any[];
        const upsertP = tenants.map(async (tenant) => {
            await collection.upsert({ _id: tenant._id }, tenant, null);

            // Skip creating anything with credentials - we assume this is external to us and something we can't
            // or don't want to automatically create (i.e. GitHub)
            if (!tenant.storage.credentials) {
                await getOrCreateRepository(tenant.storage.url, tenant.storage.owner, tenant.storage.repository);
            }
        });
        await Promise.all(upsertP);

        const loggerFormat = config.get("logger:morganFormat");
        const port = utils.normalizePort(process.env.PORT || "5000");
        const serverUrl = config.get("worker:serverUrl");

        return new RiddlerResources(tenantsCollectionName, mongoManager, port, loggerFormat, serverUrl);
    }
}

export class RiddlerRunnerFactory implements utils.IRunnerFactory<RiddlerResources> {
    public async create(resources: RiddlerResources): Promise<utils.IRunner> {
        return new RiddlerRunner(
            resources.tenantsCollectionName,
            resources.port,
            resources.mongoManager,
            resources.loggerFormat,
            resources.baseOrdererUrl);
    }
}
