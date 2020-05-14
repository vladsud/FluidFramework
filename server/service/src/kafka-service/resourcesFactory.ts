/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { KafkaResources } from "@microsoft/fluid-server-lambdas";
import { IPartitionLambdaFactory } from "@microsoft/fluid-server-services-core";
import * as utils from "@microsoft/fluid-server-services-utils";
import * as moniker from "moniker";
import { Provider } from "nconf";
import { RdkafkaConsumer } from "../rdkafka";

export class KafkaResourcesFactory implements utils.IResourcesFactory<KafkaResources> {
    constructor(private name, private lambdaModule) {
    }

    public async create(config: Provider): Promise<KafkaResources> {
        // tslint:disable-next-line:non-literal-require
        const plugin = require(this.lambdaModule);
        const lambdaFactory = await plugin.create(config) as IPartitionLambdaFactory;

        // Inbound Kafka configuration
        const kafkaEndpoint = config.get("kafka:endpoint");

        // Receive topic and group - for now we will assume an entry in config mapping
        // to the given name. Later though the lambda config will likely be split from the stream config
        const streamConfig = config.get(`lambdas:${this.name}`);
        const groupId = streamConfig.group;
        const receiveTopic = streamConfig.topic;

        const clientId = moniker.choose();
        const consumer = new RdkafkaConsumer(kafkaEndpoint, clientId, groupId, receiveTopic, false);

        return new KafkaResources(
            lambdaFactory,
            consumer,
            config);
    }
}