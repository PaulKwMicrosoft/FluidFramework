/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IOrderer } from "@microsoft/fluid-server-services-core";
import * as assert from "assert";
import { IConcreteNode, IConcreteNodeFactory, IReservationManager } from "./interfaces";

// The LocalOrderManager maintains a set of nodes and their set of ownerships of documents
// It then provides caches of orderers
export class LocalOrderManager {
    private localOrderers = new Map<string, Promise<IOrderer>>();
    private localNodeP: Promise<IConcreteNode>;

    constructor(private nodeFactory: IConcreteNodeFactory, private reservationManager: IReservationManager) {
        this.createLocalNode();
    }

    public async get(tenantId: string, documentId: string): Promise<IOrderer> {
        const key = this.getKey(tenantId, documentId);

        let ordererP = this.localOrderers.get(key);
        if (!ordererP) {
            ordererP = this.getCore(tenantId, documentId);
            this.localOrderers.set(key, ordererP);
        }

        return ordererP;
    }

    public async remove(tenantId: string, documentId: string) {
        const key = this.getKey(tenantId, documentId);

        const ordererP = this.localOrderers.get(key);
        if (ordererP) {
            this.localOrderers.delete(key);

            const orderer = await ordererP;
            await orderer.close();
        }
    }

    // Factory method to either create a local or proxy orderer.
    // I should have the order manager just have registered factories for types of ordering
    private async getCore(tenantId: string, documentId: string): Promise<IOrderer> {
        const localNode = await this.localNodeP;

        const key = this.getKey(tenantId, documentId);
        const reservedNode = await this.reservationManager.getOrReserve(key, localNode);
        assert(reservedNode.valid);

        const orderer = await reservedNode.connectOrderer(tenantId, documentId);

        return orderer;
    }

    private createLocalNode() {
        this.localNodeP = this.nodeFactory.create();
        this.localNodeP.then(
            (localNode) => {
                localNode.on("error", (error) => {
                    // handle disconnects, error, etc... and create a new node
                });
            },
            (error) => {
                // Reconnect the node
            });
    }

    private getKey(tenantId: string, documentId: string) {
        return `${tenantId}/${documentId}`;
    }
}
