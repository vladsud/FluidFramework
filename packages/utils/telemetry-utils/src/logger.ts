/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    ITelemetryBaseEvent,
    ITelemetryBaseLogger,
    ITelemetryErrorEvent,
    ITelemetryGenericEvent,
    ITelemetryLogger,
    ITelemetryPerformanceEvent,
    ITelemetryProperties,
    TelemetryEventPropertyType,
} from "@fluidframework/common-definitions";
import { BaseTelemetryNullLogger, performance } from "@fluidframework/common-utils";

export interface ITelemetryPropertyGetters {
    [index: string]: () => TelemetryEventPropertyType;
}

/**
 * TelemetryLogger class contains various helper telemetry methods,
 * encoding in one place schemas for various types of Fluid telemetry events.
 * Creates sub-logger that appends properties to all events
 */
export abstract class TelemetryLogger implements ITelemetryLogger {
    public static readonly eventNamespaceSeparator = ":";

    public static formatTick(tick: number): number {
        return Math.floor(tick);
    }

    /**
     * Attempts to parse number from string.
     * If fails,returns original string.
     * Used to make telemetry data typed (and support math operations, like comparison),
     * in places where we do expect numbers (like contentsize/duration property in http header)
     */
    public static numberFromString(str: string | null | undefined): string | number | undefined {
        if (str === undefined || str === null) {
            return undefined;
        }
        const num = Number(str);
        return Number.isNaN(num) ? str : num;
    }

    public static sanitizePkgName(name: string) {
        return name.replace("@", "").replace("/", "-");
    }

    public static prepareErrorObject(event: ITelemetryBaseEvent, error: any, fetchStack: boolean) {
        if (error === null || typeof error !== "object") {
            event.error = error;
        } else {
            // WARNING: Exceptions can contain PII!
            // For example, XHR will throw object derived from Error that contains config information
            // for failed request, including all the headers, and thus - user tokens!
            // Extract only call stack, message, and couple network-related properties form error object

            const errorAsObject = error as {
                stack?: string;
                message?: string;
            };

            event.stack = errorAsObject.stack;
            event.error = errorAsObject.message;

            // Error message can contain PII information.
            // If we know for sure it does, we have to not log it.
            if (error.containsPII) {
                event.error = "Error message was removed as it contained PII";
            } else if (error.getTelemetryProperties) {
                const telemetryProps: ITelemetryProperties = error.getTelemetryProperties();
                for (const key of Object.keys(telemetryProps)) {
                    if (event[key] === undefined) {
                        event[key] = telemetryProps[key];
                    }
                }
            }
        }

        // Collect stack if we were not able to extract it from error
        if (event.stack === undefined && fetchStack) {
            event.stack = TelemetryLogger.getStack();
        }
    }

    protected static getStack(): string | undefined {
        // Some browsers will populate stack right away, others require throwing Error
        let stack = new Error().stack;
        if (!stack) {
            try {
                throw new Error();
            } catch (e) {
                stack = e.stack;
            }
        }
        return stack;
    }

    protected constructor(
        protected readonly namespace?: string,
        protected readonly properties?: ITelemetryProperties,
        protected readonly propertyGetters?: ITelemetryPropertyGetters) {
    }

    /**
     * Send an event with the logger
     *
     * @param event - the event to send
     */
    public abstract send(event: ITelemetryBaseEvent): void;

    /**
     * Send a telemetry event with the logger
     *
     * @param event - the event to send
     * @param error - optional error object to log
     */
    public sendTelemetryEvent(event: ITelemetryGenericEvent, error?: any) {
        const newEvent: ITelemetryBaseEvent = {
            ...event,
            category: event.category ?? (error === undefined ?  "generic" : "error"),
        };
        if (error !== undefined) {
            TelemetryLogger.prepareErrorObject(newEvent, error, false);
        }
        this.send(newEvent);
    }

    /**
     * Send an error telemetry event with the logger
     *
     * @param event - the event to send
     * @param error - optional error object to log
     */
    public sendErrorEvent(event: ITelemetryErrorEvent, error?: any) {
        this.sendTelemetryEvent({ ...event, category: "error" }, error);
    }

    /**
     * Send a performance telemetry event with the logger
     *
     * @param event - Event to send
     * @param error - optional error object to log
     */
    public sendPerformanceEvent(event: ITelemetryPerformanceEvent, error?: any): void {
        const perfEvent: ITelemetryBaseEvent = {
            ...event,
            category: event.category ? event.category : "performance",
        };
        if (error !== undefined) {
            TelemetryLogger.prepareErrorObject(perfEvent, error, false);
        }

        if (event.duration) {
            perfEvent.duration = TelemetryLogger.formatTick(event.duration);
        }

        this.send(perfEvent);
    }

    /**
     * @deprecated - use sendErrorEvent
     * Log generic error with the logger
     *
     * @param eventName - the name of the event
     * @param error - the error object to include in the event, require to be JSON-able
     */
    public logGenericError(eventName: string, error: any) {
        this.sendErrorEvent({ eventName }, error);
    }

    /**
     * @deprecated - use sendErrorEvent
     * Helper method to log exceptions
     * @param event - the event to send
     * @param exception - Exception object to add to an event
     */
    public logException(event: ITelemetryErrorEvent, exception: any): void {
        this.sendErrorEvent({ ...event, isException: true }, exception);
    }

    /**
     * @deprecated - use sendErrorEvent

     * Log an debug assert with the logger
     *
     * @param condition - the condition to assert on
     * @param event - the event to log if the condition fails
     */
    public debugAssert(condition: boolean, event?: ITelemetryErrorEvent): void {
        this.shipAssert(condition, event);
    }

    /**
     * @deprecated - use sendErrorEvent
     * Log an ship assert with the logger
     *
     * @param condition - the condition to assert on
     * @param event - the event to log if the condition fails
     */
    public shipAssert(condition: boolean, event?: ITelemetryErrorEvent): void {
        if (!condition) {
            const realEvent: ITelemetryErrorEvent = event === undefined ? { eventName: "Assert" } : event;
            realEvent.isAssert = true;
            realEvent.stack = TelemetryLogger.getStack();
            this.sendErrorEvent(realEvent);
        }
    }

    protected prepareEvent(event: ITelemetryBaseEvent): ITelemetryBaseEvent {
        const newEvent: ITelemetryBaseEvent = { ...this.properties, ...event };
        if (this.namespace !== undefined) {
            newEvent.eventName = `${this.namespace}${TelemetryLogger.eventNamespaceSeparator}${newEvent.eventName}`;
        }
        // Evaluate any getter functions
        if (this.propertyGetters) {
            for (const key of Object.keys(this.propertyGetters)) {
                if (event[key] !== undefined) {
                    // Properties directly on the event take priority
                    continue;
                }
                const getter = this.propertyGetters[key];

                // If this throws, hopefully it is handled elsewhere
                const value = getter();
                if (value !== undefined) {
                    newEvent[key] = value;
                }
            }
        }

        return newEvent;
    }
}

/**
 * ChildLogger class contains various helper telemetry methods,
 * encoding in one place schemas for various types of Fluid telemetry events.
 * Creates sub-logger that appends properties to all events
 */
export class ChildLogger extends TelemetryLogger {
    /**
     * Create child logger
     * @param baseLogger - Base logger to use to output events. If undefined, proper child logger
     * is created, but it does not sends telemetry events anywhere.
     * @param namespace - Telemetry event name prefix to add to all events
     * @param properties - Base properties to add to all events
     * @param propertyGetters - Getters to add additional properties to all events
     */
    public static create(
        baseLogger?: ITelemetryBaseLogger,
        namespace?: string,
        properties?: ITelemetryProperties,
        propertyGetters?: ITelemetryPropertyGetters): TelemetryLogger {
        // if we are creating a child of a child, rather than nest, which will increase
        // the callstack overhead, just generate a new logger that includes everything from the previous
        if (baseLogger instanceof ChildLogger) {
            const combinedProperties =
                baseLogger.properties === undefined && properties === undefined
                    ? undefined
                    : {
                        ...baseLogger.properties,
                        ...properties,
                    };
            const combinedGetters =
                baseLogger.propertyGetters === undefined && propertyGetters === undefined
                    ? undefined
                    : {
                        ...baseLogger.propertyGetters,
                        ...propertyGetters,
                    };

            const combinedNamespace = baseLogger.namespace === undefined
                ? namespace
                : namespace === undefined
                    ? baseLogger.namespace
                    : `${baseLogger.namespace}${TelemetryLogger.eventNamespaceSeparator}${namespace}`;

            return new ChildLogger(
                baseLogger.baseLogger,
                combinedNamespace,
                combinedProperties,
                combinedGetters,
            );
        }

        return new ChildLogger(
            baseLogger ? baseLogger : new BaseTelemetryNullLogger(),
            namespace,
            properties,
            propertyGetters);
    }

    constructor(
        protected readonly baseLogger: ITelemetryBaseLogger,
        namespace?: string,
        properties?: ITelemetryProperties,
        propertyGetters?: ITelemetryPropertyGetters) {
        super(namespace, properties, propertyGetters);
    }

    /**
     * Send an event with the logger
     *
     * @param event - the event to send
     */
    public send(event: ITelemetryBaseEvent): void {
        this.baseLogger.send(this.prepareEvent(event));
    }
}

/**
 * Multi-sink logger
 * Takes multiple ITelemetryBaseLogger objects (sinks) and logs all events into each sink
 * Implements ITelemetryBaseLogger (through static create() method)
 */
export class MultiSinkLogger extends TelemetryLogger {
    protected loggers: ITelemetryBaseLogger[] = [];

    /**
     * Create multiple sink logger (i.e. logger that sends events to multiple sinks)
     * @param namespace - Telemetry event name prefix to add to all events
     * @param properties - Base properties to add to all events
     * @param propertyGetters - Getters to add additional properties to all events
     */
    constructor(
        namespace?: string,
        properties?: ITelemetryProperties,
        propertyGetters?: ITelemetryPropertyGetters) {
        super(namespace, properties, propertyGetters);
    }

    /**
     * Add logger to send all events to
     * @param logger - Logger to add
     */
    public addLogger(logger?: ITelemetryBaseLogger) {
        if (logger !== undefined && logger !== null) {
            this.loggers.push(logger);
        }
    }

    /**
     * Send an event to the loggers
     *
     * @param event - the event to send to all the registered logger
     */
    public send(event: ITelemetryBaseEvent): void {
        const newEvent = this.prepareEvent(event);
        this.loggers.forEach((logger: ITelemetryBaseLogger) => {
            logger.send(newEvent);
        });
    }
}

/**
 * Describes what events PerformanceEvent should log
 * By default, all events are logged, but client can override this behavior
 * For example, there is rarely a need to record start event, as we really after
 * success / failure tracking, including duration (on success).
 */
export interface IPerformanceEventMarkers {
    start?: true;
    end?: true;
    cancel?: "generic" | "error"; // tells wether to issue "generic" or "error" category cancel event
}

/**
 * Helper class to log performance events
 */
export class PerformanceEvent {
    public static start(logger: ITelemetryLogger, event: ITelemetryGenericEvent, markers?: IPerformanceEventMarkers) {
        return new PerformanceEvent(logger, event, markers);
    }

    public static timedExec<T>(
        logger: ITelemetryLogger,
        event: ITelemetryGenericEvent,
        callback: (event: PerformanceEvent) => T,
        markers?: IPerformanceEventMarkers,
    ) {
        const perfEvent = PerformanceEvent.start(logger, event, markers);
        try {
            const ret = callback(perfEvent);
            // Event might have been cancelled or ended in the callback
            if (perfEvent.event) {
                perfEvent.end();
            }
            return ret;
        } catch (error) {
            perfEvent.cancel(undefined, error);
            throw error;
        }
    }

    public static async timedExecAsync<T>(
        logger: ITelemetryLogger,
        event: ITelemetryGenericEvent,
        callback: (event: PerformanceEvent) => Promise<T>,
        markers?: IPerformanceEventMarkers,
    ) {
        const perfEvent = PerformanceEvent.start(logger, event, markers);
        try {
            const ret = await callback(perfEvent);
            // Event might have been cancelled or ended in the callback
            if (perfEvent.event) {
                perfEvent.end();
            }
            return ret;
        } catch (error) {
            perfEvent.cancel(undefined, error);
            throw error;
        }
    }

    private event?: ITelemetryGenericEvent;
    private readonly startTime = performance.now();
    private startMark?: string;

    protected constructor(
        private readonly logger: ITelemetryLogger,
        event: ITelemetryGenericEvent,
        private readonly markers: IPerformanceEventMarkers = {start: true, end: true, cancel: "generic"},
    ) {
        this.event = { ...event };
        if (this.markers.start) {
            this.reportEvent("start");
        }

        if (typeof window === "object" && window != null && window.performance) {
            this.startMark = `${event.eventName}-start`;
            window.performance.mark(this.startMark);
        }
    }

    public reportProgress(props?: ITelemetryProperties, eventNameSuffix: string = "update"): void {
        this.reportEvent(eventNameSuffix, props);
    }

    public end(props?: ITelemetryProperties, eventNameSuffix = "end"): void {
        if (this.markers.end) {
            this.reportEvent(eventNameSuffix, props);
        }

        if (this.startMark && this.event) {
            const endMark = `${this.event.eventName}-${eventNameSuffix}`;
            window.performance.mark(endMark);
            window.performance.measure(`${this.event.eventName}`, this.startMark, endMark);
            this.startMark = undefined;
        }

        this.event = undefined;
    }

    public cancel(props?: ITelemetryProperties, error?: any): void {
        if (this.markers.cancel !== undefined) {
            this.reportEvent("cancel", {category: this.markers.cancel, ...props}, error);
        }
        this.event = undefined;
    }

    /**
     * Report the event, if it hasn't already been reported.
     */
    public reportEvent(eventNameSuffix: string, props?: ITelemetryProperties, error?: any) {
        // There are strange sequences involving muliple Promise chains
        // where the event can be cancelled and then later a callback is invoked
        // and the caller attempts to end directly, e.g. issue #3936. Just return.
        if (!this.event) {
            return;
        }

        const event: ITelemetryPerformanceEvent = { ...this.event, ...props };
        event.eventName = `${event.eventName}_${eventNameSuffix}`;
        if (eventNameSuffix !== "start") {
            event.duration = performance.now() - this.startTime;
        }

        this.logger.sendPerformanceEvent(event, error);
    }
}

/**
 * - Helper class for error tracking that can be used to log an error in telemetry.
 * - Care needs to be taken not to log PII information!
 * - This allows additional properties to be logged because object of this instance will record all of their properties
 *   when logged with a logger.
 * - Logger ignores all properties from any other error objects (not being instance of LoggingError), with exception of
 *   'message' & 'stack' properties if they exists on error object.
 * - In other words, logger logs only what it knows about and has good confidence it does not container PII information.
 */
export class LoggingError extends Error {
    constructor(
        message: string,
        props?: ITelemetryProperties,
    ) {
        super(message);
        if (props) {
            this.addProperties(props);
        }
    }

    public addProperties(props: ITelemetryProperties) {
        Object.assign(this, props);
    }

    // Return all properties
    public getTelemetryProperties(): ITelemetryProperties {
        const props: ITelemetryProperties = {};
        // Could not use {...this} because it does not return properties of base class.
        for (const key of Object.getOwnPropertyNames(this)) {
            props[key] = this[key];
        }
        return props;
    }
}
