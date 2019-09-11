/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IKafkaMessage, IProducer } from "@microsoft/fluid-server-services-core";
import * as Deque from "double-ended-queue";
import { IKafkaSubscriber } from "./interfaces";
import { LocalKafkaSubscription } from "./localKafkaSubscription";

/**
 * Simple Kafka simulation
 * Lambdas can subscribe to messages.
 * Each subscription keeps track of its offset in the queue.
 * Queue is cleaned up once all subscriptions processed past the min.
 */
export class LocalKafka implements IProducer {

    private readonly subscriptions: LocalKafkaSubscription[] = [];

    private readonly qeueue = new Deque<IKafkaMessage>();

    private minimumQueueOffset = 0;

    constructor(private messageOffset = 0) {
    }

    public subscribe(kafakaSubscriber: IKafkaSubscriber) {
        const kafkaSubscription = new LocalKafkaSubscription(kafakaSubscriber, this.qeueue);
        kafkaSubscription.on("processed", (queueOffset) => {
            if (this.minimumQueueOffset >= queueOffset) {
                return;
            }

            // check if this queueOffset is the min
            for (const subscription of this.subscriptions) {
                if (subscription.queueOffset < queueOffset) {
                    return;
                }
            }

            const diff = queueOffset - this.minimumQueueOffset;
            this.minimumQueueOffset = queueOffset;

            // remove items before min queue offset
            for (let i = 0; i < diff; i++) {
                this.qeueue.shift();
            }

            // update offsets in each subscription to account for the queue index changing
            for (const subscription of this.subscriptions) {
                subscription.queueOffset -= diff;
            }
        });

        this.subscriptions.push(kafkaSubscription);
    }

    public async send(messages: object[], topic: string): Promise<any> {
        for (const message of messages) {
            const kafkaMessage: IKafkaMessage = {
                highWaterOffset: this.messageOffset,
                key: topic,
                offset: this.messageOffset,
                partition: 0,
                topic,
                value: JSON.stringify(message),
            };

            this.messageOffset++;

            this.qeueue.push(kafkaMessage);
        }

        for (const subscription of this.subscriptions) {
            subscription.process();
        }
    }

    public async close(): Promise<void> {
        this.qeueue.clear();

        for (const subscription of this.subscriptions) {
            subscription.close();
        }

        this.subscriptions.length = 0;
    }

}
